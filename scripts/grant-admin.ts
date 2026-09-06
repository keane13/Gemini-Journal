/**
 * @file scripts/grant-admin.ts
 * FEATURE 7: Local operator script for bootstrapping and managing administrator roles.
 *
 * Usage:
 *   npx tsx scripts/grant-admin.ts --email founder@example.com
 *   npx tsx scripts/grant-admin.ts --uid 8Kx2mQ...
 *   npx tsx scripts/grant-admin.ts --email founder@example.com --revoke
 *   npx tsx scripts/grant-admin.ts --email founder@example.com --check
 *
 * Requires a Google credential with permission to administer Firebase Auth:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *
 * This script talks ONLY to the Firebase Auth control plane. It has no Firestore access
 * and therefore cannot read journal content -- the same boundary the console enforces.
 */

import {
  lookupByEmail,
  lookupByUid,
  setUserRole,
  type AccountRecord,
} from '../lib/server/identity-toolkit';

interface Args {
  email?: string;
  uid?: string;
  revoke: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { revoke: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email') args.email = argv[++i];
    else if (arg === '--uid') args.uid = argv[++i];
    else if (arg === '--revoke') args.revoke = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
  }
  return args;
}

function usage(): void {
  console.log(
    [
      '',
      'grant-admin -- manage administrator role claims',
      '',
      '  --email <address>   target account by email',
      '  --uid <uid>         target account by uid',
      '  --revoke            demote to role=user (also revokes sessions)',
      '  --check             report current state without changing anything',
      '',
      'Requires GOOGLE_APPLICATION_CREDENTIALS, or ambient credentials on GCP.',
      '',
    ].join('\n')
  );
}

function describe(account: AccountRecord): string {
  return [
    `  uid            ${account.uid}`,
    `  email          ${account.email ?? '(none)'}`,
    `  emailVerified  ${account.emailVerified}`,
    `  disabled       ${account.disabled}`,
    `  role           ${account.claims.role ?? 'user'}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email && !args.uid) {
    usage();
    throw new Error('Specify --email or --uid.');
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn(
      'warning: GOOGLE_APPLICATION_CREDENTIALS is not set; falling back to ambient GCP credentials.\n'
    );
  }

  const account = args.uid ? await lookupByUid(args.uid) : await lookupByEmail(args.email!);

  if (!account) {
    throw new Error(
      `No account found for ${args.uid ? `uid ${args.uid}` : `email ${args.email}`}. ` +
        'The user must sign in at least once before a role can be assigned.'
    );
  }

  console.log('\nCurrent state:');
  console.log(describe(account));

  if (args.check) {
    console.log('\n--check specified; no changes made.\n');
    return;
  }

  const nextRole = args.revoke ? 'user' : 'admin';
  if ((account.claims.role ?? 'user') === nextRole) {
    console.log(`\nAlready role=${nextRole}; nothing to do.\n`);
    return;
  }

  // Refuse to promote an account that has not proven control of its email address:
  // the console's bootstrap path enforces the same rule, and the two must agree.
  if (nextRole === 'admin' && !account.emailVerified) {
    throw new Error(
      'Refusing to grant admin to an account with an unverified email address. ' +
        'Verify the address first.'
    );
  }

  await setUserRole(account.uid, nextRole);

  console.log(`\nrole=${nextRole} applied to ${account.uid}.`);
  console.log(
    nextRole === 'admin'
      ? 'The claim takes effect on the account\'s next ID token refresh (sign out and in, or force-refresh).\n'
      : 'Sessions revoked; the demotion is effective immediately.\n'
  );
}

main().catch((err) => {
  console.error(`\nerror: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
