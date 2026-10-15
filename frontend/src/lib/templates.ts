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
]
