/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as parcelWatcher from '@parcel/watcher';
import { existsSync } from 'fs';
import { RunOnceScheduler } from 'vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { Emitter } from 'vs/base/common/event';
import { parse, ParsedPattern } from 'vs/base/common/glob';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { TernarySearchTree } from 'vs/base/common/map';
import { normalizeNFC } from 'vs/base/common/normalization';
import { isLinux, isMacintosh, isWindows } from 'vs/base/common/platform';
import { realcaseSync, realpathSync } from 'vs/base/node/extpath';
import { FileChangeType } from 'vs/platform/files/common/files';
import { IWatcherService } from 'vs/platform/files/node/watcher/parcel/watcher';
import { IDiskFileChange, ILogMessage, normalizeFileChanges, IWatchRequest } from 'vs/platform/files/node/watcher/watcher';

interface IWatcher extends IDisposable {

	/**
	 * The Parcel watcher instance is resolved when the watching has started.
	 */
	readonly instance: Promise<parcelWatcher.AsyncSubscription | undefined>;

	/**
	 * The watch request associated to the watcher.
	 */
	request: IWatchRequest;

	/**
	 * Associated ignored patterns for the watcher that can be updated.
	 */
	ignored: ParsedPattern[];

	/**
	 * How often this watcher has been restarted in case of an unexpected
	 * shutdown.
	 */
	restarts: number;

	/**
	 * The cancellation token associated with the lifecycle of the watcher.
	 */
	token: CancellationToken;
}

export class ParcelWatcherService extends Disposable implements IWatcherService {

	private static readonly MAX_RESTARTS = 5; // number of restarts we allow before giving up in case of unexpected errors

	private static readonly MAP_PARCEL_WATCHER_ACTION_TO_FILE_CHANGE = new Map<parcelWatcher.EventType, number>(
		[
			['create', FileChangeType.ADDED],
			['update', FileChangeType.UPDATED],
			['delete', FileChangeType.DELETED]
		]
	);

	private static readonly PARCEL_WATCHER_BACKEND = isWindows ? 'windows' : isLinux ? 'inotify' : 'fs-events';

	private readonly _onDidChangeFile = this._register(new Emitter<IDiskFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly _onDidLogMessage = this._register(new Emitter<ILogMessage>());
	readonly onDidLogMessage = this._onDidLogMessage.event;

	protected readonly watchers = new Map<string, IWatcher>();

	private verboseLogging = false;
	private enospcErrorLogged = false;

	constructor() {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {

		// Error handling on process
		process.on('uncaughtException', error => this.onUnexpectedError(error));
		process.on('unhandledRejection', error => this.onUnexpectedError(error));
	}

	async watch(requests: IWatchRequest[]): Promise<void> {

		// Figure out duplicates to remove from the requests
		const normalizedRequests = this.normalizeRequests(requests);

		// Gather paths that we should start watching
		const requestsToStartWatching = normalizedRequests.filter(request => {
			const watcher = this.watchers.get(request.path);
			if (!watcher) {
				return true; // not yet watching that path
			}

			// Re-watch path if excludes have changed
			return watcher.request.excludes !== request.excludes;
		});

		// Gather paths that we should stop watching
		const pathsToStopWatching = Array.from(this.watchers.values()).filter(({ request }) => {
			return !normalizedRequests.find(normalizedRequest => normalizedRequest.path === request.path && normalizedRequest.excludes === request.excludes);
		}).map(({ request }) => request.path);

		// Logging
		this.debug(`Request to start watching: ${requestsToStartWatching.map(request => `${request.path} (excludes: ${request.excludes})`).join(',')}`);
		this.debug(`Request to stop watching: ${pathsToStopWatching.join(',')}`);

		// Stop watching as instructed
		for (const pathToStopWatching of pathsToStopWatching) {
			this.stopWatching(pathToStopWatching);
		}

		// Start watching as instructed
		for (const request of requestsToStartWatching) {
			this.startWatching(request);
		}
	}

	private toExcludePatterns(excludes: string[] | undefined): ParsedPattern[] {
		return Array.isArray(excludes) ? excludes.map(exclude => parse(exclude)) : [];
	}

	private startWatching(request: IWatchRequest, restarts = 0): void {
		const cts = new CancellationTokenSource();

		let parcelWatcherPromiseResolve: (watcher: parcelWatcher.AsyncSubscription | undefined) => void;
		const instance = new Promise<parcelWatcher.AsyncSubscription | undefined>(resolve => parcelWatcherPromiseResolve = resolve);

		// Remember as watcher instance
		const watcher: IWatcher = {
			request,
			instance,
			ignored: this.toExcludePatterns(request.excludes),
			restarts,
			token: cts.token,
			dispose: () => {
				cts.dispose(true);
				instance.then(instance => instance?.unsubscribe());
			}
		};
		this.watchers.set(request.path, watcher);

		// Path checks for symbolic links / wrong casing
		const { realPath, realPathDiffers, realPathLength } = this.normalizePath(request);

		let undeliveredFileEvents: IDiskFileChange[] = [];

		const onRawFileEvent = (path: string, type: FileChangeType) => {
			if (this.verboseLogging) {
				this.log(`${type === FileChangeType.ADDED ? '[ADDED]' : type === FileChangeType.DELETED ? '[DELETED]' : '[CHANGED]'} ${path}`);
			}

			if (!this.isPathIgnored(path, watcher.ignored)) {
				undeliveredFileEvents.push({ type, path });
			} else {
				if (this.verboseLogging) {
					this.log(` >> ignored ${path}`);
				}
			}
		};

		parcelWatcher.subscribe(realPath, (error, events) => {
			if (watcher.token.isCancellationRequested) {
				return; // return early when disposed
			}

			if (error) {
				this.error(`Unexpected error in event callback: ${toErrorMessage(error)}`, watcher);
			}

			if (events.length === 0) {
				return; // assume this can happen if we had an error before
			}

			for (const event of events) {
				onRawFileEvent(event.path, ParcelWatcherService.MAP_PARCEL_WATCHER_ACTION_TO_FILE_CHANGE.get(event.type)!);
			}

			// Reset undelivered events array
			const undeliveredFileEventsToEmit = undeliveredFileEvents;
			undeliveredFileEvents = [];

			// Broadcast to clients normalized
			const normalizedEvents = normalizeFileChanges(this.normalizeEvents(undeliveredFileEventsToEmit, request, realPathDiffers, realPathLength));
			this.emitEvents(normalizedEvents);
		}, {
			backend: ParcelWatcherService.PARCEL_WATCHER_BACKEND,
			ignore: watcher.request.excludes
		}).then(async parcelWatcher => {
			this.debug(`Started watching: ${realPath}`);

			parcelWatcherPromiseResolve(parcelWatcher);
		}).catch(error => {
			this.onUnexpectedError(error, watcher);

			parcelWatcherPromiseResolve(undefined);
		});
	}

	private emitEvents(events: IDiskFileChange[]): void {

		// Send outside
		this._onDidChangeFile.fire(events);

		// Logging
		if (this.verboseLogging) {
			for (const event of events) {
				this.log(` >> normalized ${event.type === FileChangeType.ADDED ? '[ADDED]' : event.type === FileChangeType.DELETED ? '[DELETED]' : '[CHANGED]'} ${event.path}`);
			}
		}
	}

	private normalizePath(request: IWatchRequest): { realPath: string, realPathDiffers: boolean, realPathLength: number } {
		let realPath = request.path;
		let realPathDiffers = false;
		let realPathLength = request.path.length;

		try {

			// First check for symbolic link
			realPath = realpathSync(request.path);

			// Second check for casing difference
			if (request.path === realPath) {
				realPath = realcaseSync(request.path) ?? request.path;
			}

			if (request.path !== realPath) {
				realPathLength = realPath.length;
				realPathDiffers = true;

				this.warn(`correcting a path to watch that seems to be a symbolic link (original: ${request.path}, real: ${realPath})`);
			}
		} catch (error) {
			// ignore
		}

		return { realPath, realPathDiffers, realPathLength };
	}

	private normalizeEvents(events: IDiskFileChange[], request: IWatchRequest, realPathDiffers: boolean, realPathLength: number): IDiskFileChange[] {
		for (const event of events) {

			// Mac uses NFD unicode form on disk, but we want NFC
			if (isMacintosh) {
				event.path = normalizeNFC(event.path);
			}

			// Convert paths back to original form in case it differs
			if (realPathDiffers) {
				event.path = request.path + event.path.substr(realPathLength);
			}
		}

		return events;
	}

	private onUnexpectedError(error: unknown, watcher?: IWatcher): void {
		const msg = toErrorMessage(error);

		// Specially handle ENOSPC errors that can happen when
		// the watcher consumes so many file descriptors that
		// we are running into a limit. We only want to warn
		// once in this case to avoid log spam.
		// See https://github.com/microsoft/vscode/issues/7950
		if (msg.indexOf('No space left on device') !== -1) {
			if (!this.enospcErrorLogged) {
				this.error('Inotify limit reached (ENOSPC)', watcher);

				this.enospcErrorLogged = true;
			}
		}

		// Any other error is unexpected and we should try to
		// restart the watcher as a result to get into healthy
		// state again if possible and if not attempted too much
		else {
			if (watcher && watcher.restarts < ParcelWatcherService.MAX_RESTARTS) {
				if (existsSync(watcher.request.path)) {
					this.warn(`Watcher will be restarted due to unexpected error: ${error}`, watcher);
					this.restartWatching(watcher);
				} else {
					this.error(`Unexpected error: ${msg} (EUNKNOWN: path ${watcher.request.path} no longer exists)`, watcher);
				}
			} else {
				this.error(`Unexpected error: ${msg} (EUNKNOWN)`, watcher);
			}
		}
	}

	async stop(): Promise<void> {
		for (const [path] of this.watchers) {
			this.stopWatching(path);
		}

		this.watchers.clear();
	}

	private restartWatching(watcher: IWatcher, delay = 800): void {

		// Restart watcher delayed to accomodate for
		// changes on disk that have triggered the
		// need for a restart in the first place.
		const scheduler = new RunOnceScheduler(() => {
			if (watcher.token.isCancellationRequested) {
				return; // return early when disposed
			}

			// Stop/start watcher counting the restarts
			this.stopWatching(watcher.request.path);
			this.startWatching(watcher.request, watcher.restarts + 1);
		}, delay);

		scheduler.schedule();
		watcher.token.onCancellationRequested(() => scheduler.dispose());
	}

	private stopWatching(path: string): void {
		const watcher = this.watchers.get(path);
		if (watcher) {
			watcher.dispose();
			this.watchers.delete(path);
		}
	}

	protected normalizeRequests(requests: IWatchRequest[]): IWatchRequest[] {
		const requestTrie = TernarySearchTree.forPaths<IWatchRequest>();

		// Sort requests by path length to have shortest first
		// to have a way to prevent children to be watched if
		// parents exist.
		requests.sort((requestA, requestB) => requestA.path.length - requestB.path.length);

		// Only consider requests for watching that are not
		// a child of an existing request path to prevent
		// duplication.
		//
		// However, allow explicit requests to watch folders
		// that are symbolic links because the Parcel watcher
		// does not allow to recursively watch symbolic links.
		for (const request of requests) {
			if (requestTrie.findSubstr(request.path)) {
				try {
					const realpath = realpathSync(request.path);
					if (realpath === request.path) {
						this.warn(`ignoring a path for watching who's parent is already watched: ${request.path}`);

						continue; // path is not a symbolic link or similar
					}
				} catch (error) {
					continue; // invalid path - ignore from watching
				}
			}

			requestTrie.set(request.path, request);
		}

		return Array.from(requestTrie).map(([, request]) => request);
	}

	private isPathIgnored(absolutePath: string, ignored: ParsedPattern[]): boolean {
		return ignored.some(ignore => ignore(absolutePath));
	}

	async setVerboseLogging(enabled: boolean): Promise<void> {
		this.verboseLogging = enabled;
	}

	private log(message: string) {
		this._onDidLogMessage.fire({ type: 'trace', message: this.toMessage(message) });
	}

	private warn(message: string, watcher?: IWatcher) {
		this._onDidLogMessage.fire({ type: 'warn', message: this.toMessage(message, watcher) });
	}

	private error(message: string, watcher: IWatcher | undefined) {
		this._onDidLogMessage.fire({ type: 'error', message: this.toMessage(message, watcher) });
	}

	private debug(message: string): void {
		this._onDidLogMessage.fire({ type: 'debug', message: this.toMessage(message) });
	}

	private toMessage(message: string, watcher?: IWatcher): string {
		return watcher ? `[File Watcher (parcel)] ${message} (path: ${watcher.request.path})` : `[File Watcher (parcel)] ${message}`;
	}
}
