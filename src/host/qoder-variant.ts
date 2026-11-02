export type QoderCliId = 'qoder' | 'qodercn'

/** The SDK control wire is shared; account roots and branded env are not. */
export function qoderVariant(cli: QoderCliId = 'qoder') {
  return cli === 'qodercn'
    ? { cli, label: 'Qoder CN', prefix: 'QODERCN_', site: 'cn', directory: '.qoder-cn',
        executable: 'qoderclicn', package: '@qodercn-ai/qoderclicn', agent: 'qoder-cli-cn' }
    : { cli, label: 'Qoder', prefix: 'QODER_', site: 'global', directory: '.qoder',
        executable: 'qodercli', package: '@qoder-ai/qodercli', agent: 'qoder-cli' }
}
