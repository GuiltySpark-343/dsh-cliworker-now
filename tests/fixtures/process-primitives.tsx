import { createElement } from 'react'

// Synthetic native skins only. Production uses Harness's public primitives.
const icon = () => createElement('svg')
export const processPrimitives = {
  IconThinkOutlineRegular: icon,
  IconFlatListOutlineRegular: icon,
  IconCodeOutlineRegular: icon,
  IconChevronUpOutlineRegular: icon,
  IconChevronDownOutlineRegular: icon,
  TextShimmer: ({ children }: any) => createElement('span', {}, children),
  StateDot: ({ state }: any) => createElement('span', { 'data-native-state': state }),
  DisclosureRow: ({ title, icon, open, expandable, onToggle, collapsedContent, children }: any) =>
    createElement(
      'section',
      { 'data-disclosure': title },
      createElement(
        'button',
        { type: 'button', disabled: !expandable, 'aria-expanded': open, onClick: onToggle },
        icon,
        title,
        !open && collapsedContent,
      ),
      open && children,
    ),
  JsonTree: ({ data, label }: any) =>
    createElement('pre', { 'data-native-viewer': 'json', 'aria-label': label }, JSON.stringify(data)),
  TerminalBlock: ({ command, output, exitCode }: any) =>
    createElement(
      'pre',
      { 'data-native-viewer': 'terminal', 'data-exit-code': exitCode },
      command,
      '\n',
      output,
    ),
  DiffBlock: ({ diffs }: any) =>
    createElement('pre', { 'data-native-viewer': 'diff' }, JSON.stringify(diffs)),
  ReadBlock: ({ lines }: any) =>
    createElement('pre', { 'data-native-viewer': 'read' }, JSON.stringify(lines)),
}
