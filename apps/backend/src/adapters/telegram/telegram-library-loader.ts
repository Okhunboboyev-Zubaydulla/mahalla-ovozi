/**
 * Shared MTProto library loader.
 *
 * Every userbot runtime path that needs the Telegram MTProto library obtains it here.
 * The loader returns the client constructor, the session constructor and the raw-update event
 * builder as one resolution, so a caller never reaches the library through a second import.
 *
 * The loader is deliberately free of caller concerns: it imports no caller-specific error
 * type, performs no logging, and throws a plain Error naming the specifier that failed. Each
 * caller wraps that failure in its own error type.
 */

export interface TelegramLibrarySpecifier {
  /** Package that exports the MTProto client constructor. */
  moduleSpecifier: string;
  /** Sub-path that exports the string-session constructor for that package. */
  sessionModuleSpecifier: string;
  /** Sub-path that exports the update event builders for that package. */
  eventsModuleSpecifier: string;
}

/**
 * The specifier the userbot runtime resolves. A library change is a one-place edit.
 */
export const DEFAULT_TELEGRAM_LIBRARY_SPECIFIER: TelegramLibrarySpecifier = {
  moduleSpecifier: 'teleproto',
  sessionModuleSpecifier: 'teleproto/sessions/index.js',
  eventsModuleSpecifier: 'teleproto/events',
};

export type TelegramLibraryClientConstructor<TClient> = new (
  session: unknown,
  apiId: number,
  apiHash: string,
  options: Record<string, unknown>,
) => TClient;

export type TelegramLibrarySessionConstructor = new (session: string) => unknown;

/**
 * A library update-event builder. Callers treat it as an opaque token they hand back to the
 * library when unsubscribing; its shape is the library's concern, not ours.
 */
export type TelegramEventBuilderConstructor = new (
  params: Record<string, unknown>,
) => unknown;

/**
 * Everything resolved from one load. `TClient` is supplied by the caller so the constructor's
 * instance type reflects exactly the library surface that caller uses; a rename in the library
 * therefore fails to compile at the call site rather than silently.
 */
export interface TelegramLibrary<TClient> {
  TelegramClient: TelegramLibraryClientConstructor<TClient>;
  StringSession: TelegramLibrarySessionConstructor;
  RawUpdateEvent: TelegramEventBuilderConstructor;
}

interface TelegramModuleShape<TClient> {
  TelegramClient?: TelegramLibraryClientConstructor<TClient>;
}

interface TelegramSessionModuleShape {
  StringSession?: TelegramLibrarySessionConstructor;
}

interface TelegramEventsModuleShape {
  Raw?: unknown;
}

/**
 * Resolves the client constructor, the string-session constructor and the raw-update event
 * builder from a single library load. Throws a plain Error when the library is unavailable or
 * does not expose the expected surface, so callers can wrap it in their own error type.
 */
export async function loadTelegramLibrary<TClient>(
  specifier: TelegramLibrarySpecifier,
): Promise<TelegramLibrary<TClient>> {
  let clientModule: TelegramModuleShape<TClient>;
  let sessionModule: TelegramSessionModuleShape;
  let eventsModule: TelegramEventsModuleShape;

  try {
    clientModule = (await import(specifier.moduleSpecifier)) as TelegramModuleShape<TClient>;
    sessionModule = (await import(specifier.sessionModuleSpecifier)) as TelegramSessionModuleShape;
    eventsModule = (await import(specifier.eventsModuleSpecifier)) as TelegramEventsModuleShape;
  } catch (cause: unknown) {
    throw new Error(
      `MTProto client library "${specifier.moduleSpecifier}" could not be loaded. Ensure it is installed in the runtime environment before starting a userbot session.`,
      { cause },
    );
  }

  const { TelegramClient } = clientModule;
  const { StringSession } = sessionModule;
  const RawUpdateEvent = eventsModule.Raw as TelegramEventBuilderConstructor | undefined;

  if (
    typeof TelegramClient !== 'function' ||
    typeof StringSession !== 'function' ||
    typeof RawUpdateEvent !== 'function'
  ) {
    throw new Error(
      `MTProto client library "${specifier.moduleSpecifier}" did not export TelegramClient, StringSession and Raw.`,
    );
  }

  return { TelegramClient, StringSession, RawUpdateEvent };
}
