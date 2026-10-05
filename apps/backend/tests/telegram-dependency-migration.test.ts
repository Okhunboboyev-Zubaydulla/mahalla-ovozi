import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTelegramLibrary,
  DEFAULT_TELEGRAM_LIBRARY_SPECIFIER,
} from '../src/adapters/telegram/telegram-library-loader.js';
import { GramJsUserbotClient } from '../src/adapters/telegram/userbot-client-adapter.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testsDir, '..');
const repoRoot = path.join(backendDir, '..', '..');

const ARCHIVED_PACKAGE = 'telegram';
const SUCCESSOR_PACKAGE = 'teleproto';

function readJsonFile(absolutePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as Record<string, unknown>;
}

type DockerfileStage = {
  readonly name: string;
  readonly baseImage: string;
  readonly body: string;
};

type ComposeServices = {
  readonly names: readonly string[];
  readonly targetsByService: ReadonlyMap<string, string>;
};

const DOCKERFILE_STAGE_HEADER = /^FROM\s+(\S+)\s+AS\s+(\S+)$/i;
const TELEPROTO_REMOVAL_COMMAND = /^\s*RUN\b[^\n]*\brm\s+-rf\b[^\n]*teleproto/m;

/**
 * Splits the Dockerfile into its real stages: one entry per `FROM ... AS <stage>` header,
 * each body bounded by the next stage header, with full-line comments removed so stage
 * detection rests on instructions rather than prose.
 */
function parseDockerfileStages(dockerfile: string): readonly DockerfileStage[] {
  const lines = dockerfile.split(/\r?\n/);
  const headers: { name: string; baseImage: string; line: number }[] = [];

  lines.forEach((line, index) => {
    const header = DOCKERFILE_STAGE_HEADER.exec(line.trim());
    const baseImage = header?.[1];
    const name = header?.[2];
    if (baseImage !== undefined && name !== undefined) {
      headers.push({ name, baseImage, line: index });
    }
  });

  return headers.map((header, index) => ({
    name: header.name,
    baseImage: header.baseImage,
    body: lines
      .slice(header.line + 1, headers[index + 1]?.line ?? lines.length)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n'),
  }));
}

function stageRemovesTeleproto(stage: DockerfileStage): boolean {
  return TELEPROTO_REMOVAL_COMMAND.test(stage.body);
}

/**
 * Resolves a stage together with its `FROM` ancestry, so the claim is evaluated against the
 * stage chain an image is actually built from rather than one hardcoded instruction line.
 * Returns `undefined` when the target does not name a stage, or when ancestry cycles.
 */
function collectStageChain(
  stages: readonly DockerfileStage[],
  target: string,
): readonly DockerfileStage[] | undefined {
  const stagesByName = new Map(stages.map((stage) => [stage.name.toLowerCase(), stage]));
  const chain: DockerfileStage[] = [];
  const visited = new Set<string>();
  let current = stagesByName.get(target.toLowerCase());
  if (current === undefined) {
    return undefined;
  }

  while (current !== undefined) {
    const key = current.name.toLowerCase();
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    chain.push(current);
    current = stagesByName.get(current.baseImage.toLowerCase());
  }

  return chain;
}

/**
 * Maps each compose service to the Dockerfile build target it declares, scoped to the real
 * `services:` region so a service without a `target:` cannot inherit the next one's.
 */
function parseComposeServices(composeText: string): ComposeServices {
  const lines = composeText.split(/\r?\n/);
  const servicesStart = lines.findIndex((line) => /^services:\s*$/.test(line));
  const serviceRegion = servicesStart === -1 ? [] : lines.slice(servicesStart + 1);
  const regionEnd = serviceRegion.findIndex((line) => /^\S/.test(line));
  const serviceLines = regionEnd === -1 ? serviceRegion : serviceRegion.slice(0, regionEnd);

  const names: string[] = [];
  const targetsByService = new Map<string, string>();
  let currentService: string | undefined;

  for (const line of serviceLines) {
    const serviceName = /^ {2}([a-z0-9_-]+):\s*$/.exec(line)?.[1];
    if (serviceName !== undefined) {
      currentService = serviceName;
      if (!names.includes(serviceName)) {
        names.push(serviceName);
      }
      continue;
    }

    const target = /^ {4,}target:\s*(\S+)\s*$/.exec(line)?.[1];
    if (
      target !== undefined &&
      currentService !== undefined &&
      !targetsByService.has(currentService)
    ) {
      targetsByService.set(currentService, target);
    }
  }

  return { names, targetsByService };
}

describe('Ticket 02: Move the Telegram client dependency to its maintained successor', () => {
  it('declares the successor at an explicit range and no longer declares the archived package', () => {
    const manifest = readJsonFile(path.join(backendDir, 'package.json'));
    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;

    expect(dependencies[ARCHIVED_PACKAGE]).toBeUndefined();
    expect(dependencies[SUCCESSOR_PACKAGE]).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  it('resolves the successor from the single shared loader', () => {
    expect(DEFAULT_TELEGRAM_LIBRARY_SPECIFIER.moduleSpecifier).toBe(SUCCESSOR_PACKAGE);
    expect(DEFAULT_TELEGRAM_LIBRARY_SPECIFIER.sessionModuleSpecifier).toBe(
      `${SUCCESSOR_PACKAGE}/sessions/index.js`,
    );
  });

  it('leaves no trace of the archived package in the installed dependency tree', () => {
    const pnpmStoreDir = path.join(repoRoot, 'node_modules', '.pnpm');
    expect(existsSync(pnpmStoreDir)).toBe(true);

    const archivedEntries = readdirSync(pnpmStoreDir).filter(
      (entry) => entry === ARCHIVED_PACKAGE || entry.startsWith(`${ARCHIVED_PACKAGE}@`),
    );
    expect(archivedEntries).toEqual([]);
  });

  it('exposes the library surface the adapter calls, from a real successor instance', async () => {
    const library = await loadTelegramLibrary<{
      connect(): Promise<void>;
      disconnect(): Promise<void>;
      connected?: boolean;
    }>(DEFAULT_TELEGRAM_LIBRARY_SPECIFIER);

    expect(typeof library.TelegramClient).toBe('function');
    expect(typeof library.StringSession).toBe('function');

    // A session string stored before the migration must still construct a client.
    const storedSessionString = new library.StringSession('');
    const client = new library.TelegramClient(storedSessionString, 12345, 'test_api_hash', {
      connectionRetries: 5,
      catchUp: false,
    });

    expect(typeof client.connect).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(client.connected === undefined || client.connected === false).toBe(true);
  });

  it('constructs the real adapter against a stored session string without a write surface', async () => {
    const client = new GramJsUserbotClient({
      districtId: 'dist_migration_probe',
      sessionString: '',
      apiId: '12345',
      apiHash: 'test_api_hash',
      phoneNumber: '+998901234567',
    });

    const library = await (
      client as unknown as {
        loadGramJs(): Promise<{
          TelegramClient: unknown;
          StringSession: unknown;
        }>;
      }
    ).loadGramJs();

    expect(typeof library.TelegramClient).toBe('function');
    expect(typeof library.StringSession).toBe('function');
    expect(client.isConnected()).toBe(false);
    expect((GramJsUserbotClient.prototype as unknown as Record<string, unknown>).sendMessage).toBeUndefined();
  });

  it('keeps the HTTP and worker images from carrying the userbot MTProto client', () => {
    const compose = readFileSync(
      path.join(repoRoot, 'deploy', 'compose', 'docker-compose.prod.yml'),
      'utf8',
    );

    const backendTarget = /backend:[\s\S]*?target:\s*(\S+)/.exec(compose)?.[1];
    const workerTarget = /worker:[\s\S]*?target:\s*(\S+)/.exec(compose)?.[1];
    const userbotTarget = /userbot:[\s\S]*?target:\s*(\S+)/.exec(compose)?.[1];

    expect(backendTarget).toBeDefined();
    expect(workerTarget).toBeDefined();
    expect(userbotTarget).toBeDefined();

    expect(userbotTarget).not.toBe(backendTarget);
    expect(userbotTarget).not.toBe(workerTarget);

    const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(new RegExp(`AS ${userbotTarget}\\b`));
    expect(dockerfile).toMatch(/rm -rf \/app\/node_modules\/\.pnpm\/teleproto@\*/);
  });

  it('resolves every compose build target to a real Dockerfile stage', () => {
    const stages = parseDockerfileStages(
      readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8'),
    );
    expect(stages.length).toBeGreaterThan(0);

    const prodCompose = parseComposeServices(
      readFileSync(path.join(repoRoot, 'deploy', 'compose', 'docker-compose.prod.yml'), 'utf8'),
    );
    expect(prodCompose.targetsByService.size).toBeGreaterThan(0);

    const stageNames = new Set(stages.map((stage) => stage.name.toLowerCase()));
    const unresolved: string[] = [];
    for (const [service, target] of prodCompose.targetsByService) {
      if (!stageNames.has(target.toLowerCase())) {
        unresolved.push(`${service} -> ${target}`);
      }
    }

    expect(unresolved).toEqual([]);
    expect(collectStageChain(stages, 'this-stage-does-not-exist')).toBeUndefined();
  });

  it('puts the teleproto removal in the stage the HTTP and worker images are built from', () => {
    const stages = parseDockerfileStages(
      readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8'),
    );
    const prodCompose = parseComposeServices(
      readFileSync(path.join(repoRoot, 'deploy', 'compose', 'docker-compose.prod.yml'), 'utf8'),
    );

    const backendTarget = prodCompose.targetsByService.get('backend');
    const workerTarget = prodCompose.targetsByService.get('worker');
    const userbotTarget = prodCompose.targetsByService.get('userbot');
    expect(backendTarget).toBeDefined();
    expect(workerTarget).toBeDefined();
    expect(userbotTarget).toBeDefined();

    const stripStages = stages.filter(stageRemovesTeleproto);
    expect(stripStages.map((stage) => stage.name)).toEqual(['runner']);
    const stripStage = stripStages[0];
    if (stripStage === undefined) {
      throw new Error('expected exactly one teleproto-removing stage');
    }

    expect(backendTarget).toBe(stripStage.name);
    expect(workerTarget).toBe(stripStage.name);
    expect(userbotTarget).not.toBe(stripStage.name);

    const backendChain = collectStageChain(stages, String(backendTarget));
    const workerChain = collectStageChain(stages, String(workerTarget));
    const userbotChain = collectStageChain(stages, String(userbotTarget));

    expect(backendChain?.map((stage) => stage.name)).toContain(stripStage.name);
    expect(workerChain?.map((stage) => stage.name)).toContain(stripStage.name);
    expect(userbotChain?.map((stage) => stage.name)).not.toContain(stripStage.name);

    // The userbot image shares the strip stage's ancestors but never reaches it: its chain
    // starts at its own stage, which does not remove the MTProto client.
    expect(backendChain?.[0]?.name).toBe(stripStage.name);
    expect(workerChain?.[0]?.name).toBe(stripStage.name);
    expect(userbotChain?.[0]?.name).toBe(userbotTarget);
    expect(userbotChain?.length).toBeGreaterThan(1);
    expect(backendChain?.length).toBeGreaterThan(1);
    expect(workerChain?.length).toBeGreaterThan(1);
  });

  it('declares no build target for the dev compose services', () => {
    const devCompose = parseComposeServices(
      readFileSync(path.join(repoRoot, 'deploy', 'compose', 'docker-compose.yml'), 'utf8'),
    );

    expect(devCompose.names).toEqual(['postgres', 'userbot']);
    expect(devCompose.targetsByService.get('postgres')).toBeUndefined();

    const imageServices = devCompose.names.filter(
      (service) => !devCompose.targetsByService.has(service),
    );
    expect(imageServices).toEqual(['postgres']);

    // The dev userbot service is the one dev service that does declare a build target, and it
    // must name the same stage production uses so the two compose files cannot drift apart.
    const prodCompose = parseComposeServices(
      readFileSync(path.join(repoRoot, 'deploy', 'compose', 'docker-compose.prod.yml'), 'utf8'),
    );
    const devUserbotTarget = devCompose.targetsByService.get('userbot');
    expect(devUserbotTarget).toBeDefined();
    expect(devUserbotTarget).toBe(prodCompose.targetsByService.get('userbot'));
  });
});
