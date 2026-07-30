/**
 * Every API host in background.js's HOSTS table must be in manifest
 * host_permissions.
 *
 * MV3 host_permissions are what let the SERVICE WORKER fetch cross-origin
 * without CORS at all. A host that is in HOSTS but not the manifest does not
 * degrade — the fetch is blocked outright, and only in a real loaded extension,
 * which no other test in either repo can see. That is exactly the failure the
 * forge{,-stage}.adobe.io migration could have introduced by editing one file
 * and not the other.
 *
 * HOSTS is read as SOURCE TEXT rather than imported: background.js is a service
 * worker that registers chrome.runtime/chrome.tabs/chrome.action listeners at
 * module scope, and it does not export HOSTS. Parsing the literal keeps this
 * test from depending on a stubbed chrome surface, and keeps it honest about
 * what ships.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Relative to the vitest root (this repo's directory), not to this file:
// import.meta.url is not populated under vitest 4's transform.
const read = (rel) => readFileSync(resolve(process.cwd(), rel), 'utf8');

const backgroundSrc = read('src/background.js');
const manifest = JSON.parse(read('manifest.json'));

/** Origins of every https:// URL assigned inside the HOSTS object literal. */
function hostsOrigins() {
  const start = backgroundSrc.indexOf('const HOSTS = {');
  expect(start, 'HOSTS object literal not found in src/background.js').toBeGreaterThan(-1);
  const end = backgroundSrc.indexOf('\n};', start);
  expect(end, 'unterminated HOSTS literal').toBeGreaterThan(start);
  const block = backgroundSrc.slice(start, end);
  const urls = block.match(/https:\/\/[^'"\s]+/g) ?? [];
  return [...new Set(urls.map((u) => new URL(u).origin))];
}

describe('manifest host_permissions vs background.js HOSTS', () => {
  test('every HOSTS origin (api + ims, stage + prod) is permitted', () => {
    const permitted = new Set(manifest.host_permissions.map((p) => p.replace(/\/\*$/, '')));
    const origins = hostsOrigins();
    // stage.api, stage.ims, prod.api, prod.ims
    expect(origins).toHaveLength(4);
    for (const origin of origins) {
      expect(permitted, `${origin} is in HOSTS but not manifest host_permissions`)
        .toContain(origin);
    }
  });

  test('the legacy milo-core aliases stay permitted so a HOSTS revert needs no manifest edit', () => {
    // forge{,-stage} and milo-core-{prod,stage} are the same Ethos service.
    // milo-core-* is a permanent alias, not a transition window.
    expect(manifest.host_permissions).toContain('https://milo-core-prod.adobe.io/*');
    expect(manifest.host_permissions).toContain('https://milo-core-stage.adobe.io/*');
  });

  test('the committed ENV is prod, so a shipped build never writes to stage', () => {
    expect(backgroundSrc).toMatch(/^const ENV = 'prod';/m);
  });

  test('stage and prod are each paired with the matching IMS host', () => {
    // A stage token is rejected by the prod API; the pairing is the whole point
    // of one HOSTS table rather than two independent constants.
    const stage = backgroundSrc.match(/stage:\s*\{([^}]*)\}/)[1];
    const prod = backgroundSrc.match(/prod:\s*\{([^}]*)\}/)[1];
    expect(stage).toContain('https://forge-stage.adobe.io/annotations');
    expect(stage).toContain('https://ims-na1-stg1.adobelogin.com');
    expect(prod).toContain('https://forge.adobe.io/annotations');
    expect(prod).toContain('https://ims-na1.adobelogin.com');
    expect(prod).not.toContain('stg1');
  });

  test('the manifest key is unchanged, keeping the IMS redirect URI stable', () => {
    // The key pins the extension ID to nafgnogpgkcheonjkjjdfjjhnhllbkdh, which
    // is what makes https://<id>.chromiumapp.org/ a registerable redirect URI on
    // both the stage and prod IMS clients. Changing it breaks sign-in in a way
    // that reads as an IMS outage.
    expect(manifest.key).toMatch(/^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnxu2WHX9f86MTo2hJ9tq/);
  });
});
