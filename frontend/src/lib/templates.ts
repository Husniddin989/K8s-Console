/** Starting points for "Create"; the namespace placeholder is filled with the selected namespace. */
export const templates: Array<{ id: string; label: string; yaml: (namespace: string) => string }> = [
  {
    id: 'deployment',
    label: 'Deployment',
    yaml: (namespace) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${namespace}
  labels:
    app: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
`,
  },
  {
    id: 'service',
    label: 'Service',
    yaml: (namespace) => `apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: ${namespace}
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
      protocol: TCP
`,
  },
  {
    id: 'statefulset',
    label: 'StatefulSet',
    yaml: (namespace) => `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-db
  namespace: ${namespace}
spec:
  serviceName: my-db
  replicas: 1
  selector:
    matchLabels:
      app: my-db
  template:
    metadata:
      labels:
        app: my-db
    spec:
      containers:
        - name: db
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
`,
  },
  {
    id: 'daemonset',
    label: 'DaemonSet',
    yaml: (namespace) => `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-agent
  namespace: ${namespace}
spec:
  selector:
    matchLabels:
      app: node-agent
  template:
    metadata:
      labels:
        app: node-agent
    spec:
      containers:
        - name: agent
          image: busybox:1.36
          command: ["sh", "-c", "while true; do date; sleep 60; done"]
`,
  },
  {
    id: 'namespace',
    label: 'Namespace',
    yaml: () => `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`,
  },
  {
    id: 'configmap',
    label: 'ConfigMap',
    yaml: (namespace) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: ${namespace}
data:
  LOG_LEVEL: info
`,
  },
  {
    id: 'secret',
    label: 'Secret',
    yaml: (namespace) => `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: ${namespace}
type: Opaque
# stringData takes plain text; Kubernetes stores it base64-encoded.
stringData:
  username: app
  password: change-me
`,
  },
  {
    id: 'job',
    label: 'Job',
    yaml: (namespace) => `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: ${namespace}
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: ["sh", "-c", "echo hello from the console"]
`,
  },
  {
    id: 'cronjob',
    label: 'CronJob',
    yaml: (namespace) => `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cron
  namespace: ${namespace}
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 1
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: job
              image: busybox:1.36
              command: ["sh", "-c", "date; echo scheduled run"]
`,
  },
]
