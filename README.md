# K8s UI

A purpose-built Kubernetes cluster console. It shows cluster health and lists pods, deployments, services, nodes, and events with the same columns as `kubectl get … -o wide` (READY, STATUS, RESTARTS with the last restart time, AGE, IPs, ports), plus a live pod log stream. Tables sort by any column, a single search box filters every page, and the UI has light and dark themes. Frontend and API ship together in one Docker image.

Every API route and WebSocket require a signed-in user. Users have one of three roles, checked by the backend on every request:

| Role | Can do |
| --- | --- |
| `viewer` | Read every page, pod logs, and resource YAML |
| `operator` | Viewer + restart, scale and update the image of deployments, delete pods |
| `admin` | Operator + shell into pods, debug pods (ephemeral containers), create/edit any resource from YAML (server-side apply), delete deployments, services and namespaces, manage users, read the audit log |

Every change, sign-in and user change is written to the **audit log** (who, when, which resource, before/after values, result, client IP). Admins search and filter it on the *Audit log* page. Shell sessions record who opened them and for which container; the commands typed inside are not recorded.

`default`, `kube-system`, `kube-public`, `kube-node-lease` and the console's own namespace cannot be deleted from the console. Deleting a namespace or a deployment asks the user to type its name.

## Local prerequisites

- Docker Desktop (or another Docker-compatible engine) running
- `kubectl`
- `kind` and Helm
- Node.js 22+

Create a local cluster and keep its kubeconfig in a dedicated file:

```sh
kind create cluster --name k8s-ui-dev --kubeconfig "$HOME/.kube/k8s-ui-dev" --wait 5m
```

If the cluster already exists, export its kubeconfig to that file instead:

```sh
kind export kubeconfig --name k8s-ui-dev --kubeconfig "$HOME/.kube/k8s-ui-dev"
```

Using a dedicated file also avoids the `~/.kube/config is a directory` error.

## Create a local user

Users live in a JSON file of `{ username, role, passwordHash }` entries. Passwords are stored only as scrypt hashes. The `users` command prompts for the password (hidden) and writes the file with `0600` permissions:

```sh
npm install
npm run users --workspace @k8s-ui/api -- add admin admin --file .local/users.json
npm run users --workspace @k8s-ui/api -- add alice viewer --file .local/users.json
```

`.local/` is ignored by git and Docker. Other commands: `users remove <name> --file <path>` and `users hash` (prints a hash for Helm values). Passwords must be at least 10 characters.

## Run in development

```sh
export KUBECONFIG="$HOME/.kube/k8s-ui-dev"
export CLUSTER_NAME=k8s-ui-dev
export AUTH_USERS_FILE="$PWD/.local/users.json"
export DATA_DIR="$PWD/.local/data"
export SESSION_SECRET="$(openssl rand -base64 36)"
npm run dev
```

Users in `AUTH_USERS_FILE` (or Helm `auth.users`) are the bootstrap accounts; they show as "Helm / users file" in the *Users* page and can only be changed there. Admins add further users in the UI.

Open <http://127.0.0.1:5173> and sign in. The Vite dev server proxies API and log WebSocket traffic to the local backend. Without `SESSION_SECRET` the API makes a temporary one, so you are signed out whenever it restarts. All settings are listed in [`.env.example`](.env.example).

The API refuses to start when no users are configured.

## Build and run as one container

Put your users into a Helm values file (it contains password hashes, so keep it out of git):

```sh
node -e 'const u=require("./.local/users.json"); console.log("auth:\n  users: " + JSON.stringify(u))' > .local/values.local.yaml
```

Then build, load, and install:

```sh
docker build -t k8s-ui:dev .
kind load docker-image k8s-ui:dev --name k8s-ui-dev
helm upgrade --install k8s-ui deploy/helm/k8s-ui \
  --namespace k8s-ui --create-namespace \
  --set image.repository=k8s-ui --set image.tag=dev \
  --set clusterName=k8s-ui-dev \
  -f .local/values.local.yaml
kubectl -n k8s-ui port-forward svc/k8s-ui 8080:80
```

Open <http://127.0.0.1:8080>. Keep the port-forward command running while you use the page; stopping it disconnects the local URL.

Users and the audit log are stored in SQLite under `DATA_DIR` (`/data` on a PersistentVolumeClaim in Helm, `.local/data` in development). Without `DATA_DIR` they are kept in memory and lost on restart.

The chart:

- stores the user list and a generated session secret in the `k8s-ui-auth` Secret (the session secret is kept across upgrades), or uses `auth.existingSecret` with keys `users.json` and `session-secret`;
- restarts the pod when `auth.users` changes, so added, removed, or re-roled users apply at once — sessions of removed users stop working;
- refuses to render when no users are configured;
- creates a dedicated ServiceAccount with read access to namespaces, nodes, pods, pod logs, events, services, and deployments, and — with `rbac.clusterWrites: true` (the default) — write access for the console's actions: deployments (incl. scale), pods, `pods/exec`, `pods/attach`, `pods/ephemeralcontainers`, services, configmaps, namespaces, PVCs, service accounts, statefulsets, daemonsets, jobs, cronjobs, ingresses and network policies. Add more kinds for YAML apply with `rbac.extraWriteRules`. Set `rbac.clusterWrites: false` for a read-only console;
- creates a 1 Gi PersistentVolumeClaim for users and the audit log (`persistence.*`; kept on uninstall) and replaces the pod with `maxSurge: 0` so two pods never share the volume;
- uses `debugImage` (default `busybox:1.36`) for debug containers. It does not create an Ingress.

Before exposing the console beyond port-forward, put it behind HTTPS and set `auth.trustProxy` (for example `"1"` behind one Ingress hop) so the session cookie gets the `Secure` flag, or set `auth.cookieSecure: always`. If users reach it under another host name than the one the API sees, list it in `auth.trustedOrigins`.

## Sessions and security

- Sign-in sets an `HttpOnly`, `SameSite=Strict` cookie signed with `SESSION_SECRET`; it expires after `SESSION_TTL_HOURS` (default 8). The role is looked up on every request, so role changes apply to existing sessions. Resetting a user's password or disabling them in the UI ends their sessions immediately.
- Signing out clears the cookie in that browser. Sessions are stateless, so a copied cookie stays valid until it expires or the user is removed; rotate `session-secret` to end every session at once.
- Five failed sign-ins for the same user from the same address lock that pair out for 15 minutes.
- POST requests and WebSocket handshakes from another origin are rejected. Open log streams close when the session expires.

## Development commands

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` runs the backend tests (auth, roles, API errors, kubectl-style STATUS/PORT(S)/EXTERNAL-IP formatting, and log WebSocket regressions against a fake Kubernetes API) and the frontend unit tests (kubectl AGE/RESTARTS formatting, sorting, log line buffering, search filters, routing). Add a regression test next to every fix.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| API exits with `No console users are configured` | Set `AUTH_USERS_FILE` (dev) or `auth.users` (Helm). |
| Signed out after every API restart in dev | Export a fixed `SESSION_SECRET`. |
| `Cross-origin requests are not allowed` / log stream 403 | The browser origin differs from the API host; add it to `TRUSTED_ORIGINS` / `auth.trustedOrigins`. |
| `The console API is not responding (502)` | The backend or the `kubectl port-forward` stopped; start it again. |
| Pod log shows `Unable to stream pod logs` | Check the API output for the Kubernetes status code; the pod may be gone or the ServiceAccount may lack `pods/log`. |
| `~/.kube/config is a directory` | Use the dedicated kubeconfig file described above. |
| An action fails with `... is forbidden` | The ServiceAccount lacks that permission: check `rbac.clusterWrites`, or add the kind to `rbac.extraWriteRules`. |
| Shell closes with `executable file not found` | The image has no `/bin/sh` (distroless). Use *Debug* instead. |
| Debug waits on `ImagePullBackOff` | The node cannot pull `debugImage`; set one your cluster can reach. |
