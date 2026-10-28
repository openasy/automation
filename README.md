# automation

[![CI](https://github.com/openasy/automation/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/automation/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Automation product: **playbooks that act through the products when one of
them sees something, with approvals before risky steps** (ADR 0060). A SIEM signal, an alert or a schedule starts a
playbook; its steps suspend a VPN person, open an incident, ask someone in Slack, or call any API, and every run is
recorded step by step.

```
SIEM, Alertmanager, a script ──POST /hooks/<playbook>──▶                ┌─▶ vpn: suspend the person
a schedule ────────────────────────────────────────────▶  automation  ──┼─▶ incidents: open an incident
                                                          (conditions)  ├─▶ approval: wait for a person
                                                                        └─▶ Slack, Teams, any webhook
```

## Playbooks

A playbook is a trigger, conditions on the event and steps, written as JSON in the UI or sent to the API:

```json
{
  "name": "Impossible travel",
  "trigger": { "kind": "webhook" },
  "conditions": [{ "field": "signal.rule", "op": "equals", "value": "impossible-travel" }],
  "steps": [
    { "id": "suspend", "kind": "vpn.suspend", "connection": "cn_…", "person": "{{event.signal.person}}" },
    { "id": "open", "kind": "incident.open", "connection": "cn_…", "title": "Impossible travel: {{event.signal.person}}", "severity": "high" },
    { "id": "ask", "kind": "approval", "text": "Revoke the device of {{event.signal.person}}? See {{steps.open.key}}." },
    { "id": "revoke", "kind": "vpn.revoke-device", "connection": "cn_…", "device": "{{event.signal.device}}" },
    { "id": "tell", "kind": "message", "connection": "cn_…", "text": "{{steps.open.key}}: suspended and revoked." }
  ]
}
```

- **Triggers.** A webhook: `POST /hooks/<playbook>` with the playbook's own token (`oah_…`, shown once), the body is
  the event. A schedule, every 5 minutes to a week. Or by hand.
- **Conditions** on fields of the event: `equals`, `not-equals`, `contains`, `matches` (a regular expression),
  `exists`, `at-least`. All must hold; an event that does not match starts no run.
- **Steps**, in order. Text in a step is a template: `{{event.…}}`, `{{steps.<id>.…}}` for the answer of an earlier
  step, `{{run.id}}`, `{{playbook.name}}`. A step may only read steps before it; this is checked when it is saved.

| Step | What it does |
| --- | --- |
| `incident.open` | Opens an incident in Incidents. The same run and step is one incident, so a retry never opens two |
| `incident.note` | Adds a note to an incident's timeline |
| `vpn.suspend` | Suspends a person in VPN |
| `vpn.disconnect` | Ends a VPN session of a device on a server |
| `vpn.revoke-device` | Revokes a VPN device |
| `message` | Posts text to Slack, Microsoft Teams (a workflow webhook) or any webhook |
| `http` | Calls any path of a connection with a JSON body: anything else |
| `approval` | Waits for an editor to approve; refused, the run stops there |

A step that fails stops the run, unless it says `continueOnError`. The rest is recorded as skipped.

A **dry run** sends nothing and records what each step would send. A run keeps the playbook as it was when it
started, so editing a playbook never changes a run.

## Connections

Steps call **connections** and nothing else: an OpenAsy product's address with an API token made in that product,
or the URL Slack, Teams or a tool gave for a webhook. A template can change a path, never the host: a rendered path
that leaves the connection's address fails the step. Only admins add connections. Tokens and webhook URLs are sealed
with `openasy-kek`; the API and UI show a product's address and only the host of a webhook. Plain http is refused for
webhooks, except on this machine.

Give each token the role its steps need in that product: editor to open incidents, admin to suspend people in VPN.

## Runs

Each run records what started it, the event, and for each step the request (without the token), the status and
answer (up to 16,000 characters), how long it took, and who approved it. A run stopped by a restart is marked failed.
Runs are kept for 90 days.

## Run

```bash
openssl rand -hex 32 > openasy-kek
docker compose up -d
docker compose logs automation | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port: UI, API and `/hooks` |
| `AUTOMATION_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `AUTOMATION_STEP_TIMEOUT_SECONDS` | `15` | How long a step's call may take |
| `AUTOMATION_RETENTION_DAYS` | `90` | Runs that ended before this are deleted |
| `AUTOMATION_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `AUTOMATION_DB` | `/data/automation.db` | SQLite file (WAL), on the `/data` volume |
| `AUTOMATION_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `AUTOMATION_HEADLESS` | `false` | `true` serves only the API and `/hooks` |
| `AUTOMATION_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

`/metrics` has `openasy_automation_playbooks_enabled`, `openasy_automation_runs{state}` and
`openasy_automation_approvals_waiting`.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers see everything; editors also write and run playbooks, test connections and approve steps; admins also add
and change connections, delete playbooks, and manage members and API tokens (ADR 0003).

## Not yet

Playbooks are written as JSON; the drawn editor of the design is planned. Approvals are given in the UI or the API,
not by replying in Slack. There are no branches or loops: a playbook is a list of steps, and conditions apply to the
whole playbook. Built-in steps cover Incidents and VPN; other products are reached with `http` steps.

## Develop

```bash
npm install
npm test        # templates, steps, runs and approvals against fake products, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
