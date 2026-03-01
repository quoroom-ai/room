export function shouldShowManualUpdateControls(deploymentMode: 'local' | 'cloud'): boolean {
  return deploymentMode === 'local'
}

export function shouldShowUpdateModal(
  deploymentMode: 'local' | 'cloud',
  hasUpdateInfo: boolean,
  dismissed: boolean
): boolean {
  return shouldShowManualUpdateControls(deploymentMode) && hasUpdateInfo && !dismissed
}
