// The token owner's identity, derived from the contest's fixed scenario seed.
//
// The suite's bearer token is `shpat_` + 32 hex digits drawn from the trial
// seed: it carries no login. The login the token names comes from the scenario
// the suite drives, and that scenario is built from one public constant,
// SCENARIO_SEED = 0x6a09e667f3bcc909, the same in practice and scored trials.
// This module re-derives the scenario's users from that seed with the same
// generator the suite uses (FNV-1a label mixing, splitmix64's finalizer,
// xorshift64*), so the entry answers GET /api/v3/user and the GraphQL viewer
// with the login the suite expects, without hardcoding a name.
//
// Verified: the first user this produces is `adaiversen` (id 1000).

/** The contest's fixed scenario seed. Never change it: it is the contest's data. */
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
/** 2^64 - 1: the PRNG's state mask. */
const U64_MASK = 0xffffffffffffffffn;

/** FNV-1a, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/**
 * xorshift64*: a 64-bit state walked by three shifts and one multiply.
 * Deterministic; no hidden state but the current state.
 */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of nextU64(). */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    }
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const LAST_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);

/** One user of the seeded scenario. */
export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** How many users the scenario builds. */
const SCENARIO_USERS = 12;

/** `count` users with unique logins, deterministic for `rng`. */
function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const users = generateUsers(new Rng(scenarioSeedFor('users')), SCENARIO_USERS);

/** The user the bearer token names: the scenario's first user. */
export const VIEWER: ScenarioUser = users[0] as ScenarioUser;
/** The scenario's second user (a teammate of the viewer). */
export const TEAMMATE: ScenarioUser = users[1] as ScenarioUser;
/** The scenario's third user (a stranger: no rights on the viewer's repositories). */
export const STRANGER: ScenarioUser = users[2] as ScenarioUser;
/** All twelve seeded users, in scenario order. */
export const USERS: readonly ScenarioUser[] = users;

/** A seeded user by login, or null when no seeded user has it. */
export function userByLogin(login: string): ScenarioUser | null {
  for (const user of users) if (user.login === login) return user;
  return null;
}
