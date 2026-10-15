/** "deployment.scale" → "Scale deployment" for the action column. */
export function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    'auth.login': 'Sign in',
    'auth.logout': 'Sign out',
    'deployment.restart': 'Restart deployment',
    'deployment.scale': 'Scale deployment',
    'deployment.image': 'Update image',
    'deployment.delete': 'Delete deployment',
    'pod.delete': 'Delete pod',
    'pod.shell': 'Open shell',
    'pod.debug': 'Start debug container',
    'pod.attach': 'Attach to debug container',
    'service.delete': 'Delete service',
    'namespace.delete': 'Delete namespace',
    'resource.apply': 'Apply YAML',
    'user.create': 'Add user',
    'user.update': 'Change user',
    'user.delete': 'Delete user',
  }
  return labels[action] || action
}
