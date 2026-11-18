// Builds gtm/container.json, the server container the sGTM tests run against, in Tag Manager's container export
// format (Admin > Import Container): the SharedID variable template (templates/sgtm/sharedid-variable.tpl) and a
// variable using it, the echo client and tag (gtm/*.tpl) that answer /metrics/sid-echo with the variable's value, a
// GA4 client with server-managed cookies (FPID), and a Conversion Linker tag. See README.md.
//
//   npm run sgtm-container             rewrite gtm/container.json
//   npm run sgtm-container -- --check  fail if it isn't what this script writes (CI)
//
// The IDs are placeholders, as in any export: Tag Manager gives the imported items IDs of its own. A custom template's
// items name it as cvt_<containerId>_<templateId>.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const OUT = join(here, 'gtm', 'container.json');

const ACCOUNT = '1234567890';
const CONTAINER = '111111111';
const FINGERPRINT = '1763424000000';
const ids = { accountId: ACCOUNT, containerId: CONTAINER };
const cvt = (templateId: string): string => `cvt_${CONTAINER}_${templateId}`;

/** The echo client's name, which the echo tag's trigger matches. */
export const ECHO_CLIENT_NAME = 'SharedID echo';
/** The path the echo client claims. */
export const ECHO_PATH = '/metrics/sid-echo';
/** Tag Manager's built-in "All Pages" trigger in server containers (page_view events). */
const ALL_PAGES = '2147479574';

function template(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const text = (key: string, value: string) => ({ type: 'TEMPLATE', key, value });
const bool = (key: string, value: boolean) => ({ type: 'BOOLEAN', key, value: String(value) });

export function container(): unknown {
  return {
    exportFormatVersion: 2,
    exportTime: '2026-11-18 00:00:00',
    containerVersion: {
      path: `accounts/${ACCOUNT}/containers/${CONTAINER}/versions/0`,
      ...ids,
      containerVersionId: '0',
      container: {
        path: `accounts/${ACCOUNT}/containers/${CONTAINER}`,
        ...ids,
        name: 'SharedID Edge sGTM tests',
        publicId: 'GTM-XXXXXXX',
        usageContext: ['SERVER'],
        fingerprint: FINGERPRINT,
        tagManagerUrl: `https://tagmanager.google.com/#/container/accounts/${ACCOUNT}/containers/${CONTAINER}/workspaces?apiLink=container`,
        features: {
          supportUserPermissions: true,
          supportEnvironments: true,
          supportWorkspaces: true,
          supportGtagConfigs: false,
          supportBuiltInVariables: true,
          supportClients: true,
          supportFolders: true,
          supportTags: true,
          supportTemplates: true,
          supportTriggers: true,
          supportVariables: true,
          supportVersions: true,
          supportZones: true,
          supportTransformations: true
        },
        tagIds: ['GTM-XXXXXXX']
      },
      tag: [
        {
          ...ids,
          tagId: '8',
          name: 'SharedID echo response',
          type: cvt('3'),
          parameter: [text('sharedid', '{{SharedID}}')],
          fingerprint: FINGERPRINT,
          firingTriggerId: ['7'],
          tagFiringOption: 'ONCE_PER_EVENT',
          monitoringMetadata: { type: 'MAP' },
          consentSettings: { consentStatus: 'NOT_SET' }
        },
        {
          ...ids,
          tagId: '9',
          name: 'Conversion Linker',
          type: 'sgtmadscl',
          parameter: [bool('enableCookieOverrides', false)],
          fingerprint: FINGERPRINT,
          firingTriggerId: [ALL_PAGES],
          tagFiringOption: 'ONCE_PER_EVENT',
          monitoringMetadata: { type: 'MAP' },
          consentSettings: { consentStatus: 'NOT_SET' }
        }
      ],
      trigger: [
        {
          ...ids,
          triggerId: '7',
          name: 'SharedID echo',
          type: 'CUSTOM_EVENT',
          customEventFilter: [{ type: 'EQUALS', parameter: [text('arg0', '{{_event}}'), text('arg1', 'sid_echo')] }],
          filter: [{ type: 'EQUALS', parameter: [text('arg0', '{{Client Name}}'), text('arg1', ECHO_CLIENT_NAME)] }],
          fingerprint: FINGERPRINT
        }
      ],
      variable: [
        {
          ...ids,
          variableId: '4',
          name: 'SharedID',
          type: cvt('1'),
          parameter: [
            text('cookieName', '_pubcid'),
            text('recoveryCookieName', '_pubcid_sv'),
            text('optOutCookieName', '_pubcid_optout'),
            bool('honorGpc', true)
          ],
          fingerprint: FINGERPRINT,
          formatValue: {}
        }
      ],
      builtInVariable: [
        { ...ids, type: 'EVENT_NAME', name: 'Event Name' },
        { ...ids, type: 'CLIENT_NAME', name: 'Client Name' },
        { ...ids, type: 'REQUEST_PATH', name: 'Request Path' }
      ],
      fingerprint: FINGERPRINT,
      tagManagerUrl: `https://tagmanager.google.com/#/versions/accounts/${ACCOUNT}/containers/${CONTAINER}/versions/0?apiLink=version`,
      client: [
        {
          ...ids,
          clientId: '5',
          name: ECHO_CLIENT_NAME,
          type: cvt('2'),
          parameter: [text('path', ECHO_PATH)],
          fingerprint: FINGERPRINT
        },
        {
          // As docs/sgtm.md recommends with sGTM on the site's own hostname: server-managed client ID (FPID).
          ...ids,
          clientId: '6',
          name: 'GA4',
          type: 'gaaw_client',
          parameter: [
            bool('activateDefaultPaths', true),
            text('cookieManagement', 'server'),
            text('cookieName', 'FPID'),
            text('cookieDomain', 'auto'),
            text('cookiePath', '/'),
            text('cookieMaxAgeInSec', '63072000')
          ],
          fingerprint: FINGERPRINT
        }
      ],
      customTemplate: [
        {
          ...ids,
          templateId: '1',
          name: 'SharedID (SharedID Edge)',
          fingerprint: FINGERPRINT,
          templateData: template(join(here, '..', '..', 'templates', 'sgtm', 'sharedid-variable.tpl'))
        },
        {
          ...ids,
          templateId: '2',
          name: 'SharedID echo (SharedID Edge tests)',
          fingerprint: FINGERPRINT,
          templateData: template(join(here, 'gtm', 'sid-echo-client.tpl'))
        },
        {
          ...ids,
          templateId: '3',
          name: 'SharedID echo response (SharedID Edge tests)',
          fingerprint: FINGERPRINT,
          templateData: template(join(here, 'gtm', 'sid-echo-tag.tpl'))
        }
      ]
    }
  };
}

if (import.meta.filename === process.argv[1]) {
  const json = `${JSON.stringify(container(), null, 4)}\n`;
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(OUT, 'utf8'); } catch { /* missing: reported below */ }
    if (current.replace(/\r\n/g, '\n') !== json) {
      console.error('e2e/sgtm/gtm/container.json is out of date: run npm run sgtm-container in e2e/, and commit it.');
      process.exit(1);
    }
    console.log('e2e/sgtm/gtm/container.json is up to date.');
  } else {
    writeFileSync(OUT, json);
    console.log('Wrote e2e/sgtm/gtm/container.json.');
  }
}
