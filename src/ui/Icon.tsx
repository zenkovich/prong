import React from 'react';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import { useTheme } from '../theme';

export type IconName =
  | 'fetch'
  | 'pull'
  | 'push'
  | 'stash'
  | 'branch'
  | 'merge'
  | 'rebase'
  | 'settings'
  | 'search'
  | 'plus'
  | 'x'
  | 'chevronRight'
  | 'chevronDown'
  | 'check'
  | 'github'
  | 'key'
  | 'terminal'
  | 'sun'
  | 'moon'
  | 'folder'
  | 'clone'
  | 'tag'
  | 'cloud'
  | 'commit'
  | 'file'
  | 'image'
  | 'binary'
  | 'trash'
  | 'pin'
  | 'refresh'
  | 'list'
  | 'tree'
  | 'columns'
  | 'rows'
  | 'history'
  | 'user'
  | 'copy'
  | 'more'
  | 'warning'
  | 'info'
  | 'undo'
  | 'home'
  | 'sidebar'
  | 'layers'
  | 'minus'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowRight'
  | 'grip'
  | 'eye'
  | 'lock'
  | 'link'
  | 'external'
  | 'filter'
  | 'stop'
  | 'expand'
  | 'collapse'
  | 'checkCircle'
  | 'spinner'
  | 'keyboard'
  | 'edit'
  | 'agent'
  | 'send'
  | 'rotate';

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, color, strokeWidth = 1.8 }: Props) {
  const theme = useTheme();
  const c = color ?? theme.textMuted;
  const p = { stroke: c, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  const body = (() => {
    switch (name) {
      case 'fetch':
        return (
          <>
            <Path {...p} d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 1.5 8.7" />
            <Path {...p} d="M12 12v9M8 17l4 4 4-4" />
          </>
        );
      case 'pull':
        return (
          <>
            <Path {...p} d="M12 4v13M6 11l6 6 6-6" />
            <Line {...p} x1={5} y1={21} x2={19} y2={21} />
          </>
        );
      case 'push':
        return (
          <>
            <Path {...p} d="M12 20V7M6 13l6-6 6 6" />
            <Line {...p} x1={5} y1={3} x2={19} y2={3} />
          </>
        );
      case 'stash':
        return (
          <>
            <Rect {...p} x={3} y={4} width={18} height={4} rx={1} />
            <Path {...p} d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
          </>
        );
      case 'branch':
        return (
          <>
            <Line {...p} x1={6} y1={3} x2={6} y2={15} />
            <Circle {...p} cx={18} cy={6} r={3} />
            <Circle {...p} cx={6} cy={18} r={3} />
            <Path {...p} d="M18 9a9 9 0 0 1-9 9" />
          </>
        );
      case 'merge':
        return (
          <>
            <Circle {...p} cx={18} cy={18} r={3} />
            <Circle {...p} cx={6} cy={6} r={3} />
            <Path {...p} d="M6 21V9a9 9 0 0 0 9 9" />
          </>
        );
      case 'rebase':
        return (
          <>
            <Circle {...p} cx={6} cy={6} r={3} />
            <Circle {...p} cx={6} cy={18} r={3} />
            <Path {...p} d="M6 9v6M18 3v8a4 4 0 0 1-4 4h-3" />
            <Path {...p} d="M13 12l-2 3 2 3" />
          </>
        );
      case 'settings':
        return (
          <>
            <Circle {...p} cx={12} cy={12} r={3} />
            <Path {...p} d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </>
        );
      case 'search':
        return (
          <>
            <Circle {...p} cx={11} cy={11} r={7} />
            <Line {...p} x1={21} y1={21} x2={16.5} y2={16.5} />
          </>
        );
      case 'plus':
        return <Path {...p} d="M12 5v14M5 12h14" />;
      case 'minus':
        return <Path {...p} d="M5 12h14" />;
      case 'x':
        return <Path {...p} d="M18 6L6 18M6 6l12 12" />;
      case 'chevronRight':
        return <Polyline {...p} points="9 6 15 12 9 18" />;
      case 'chevronDown':
        return <Polyline {...p} points="6 9 12 15 18 9" />;
      case 'check':
        return <Polyline {...p} points="20 6 9 17 4 12" />;
      case 'checkCircle':
        return (
          <>
            <Circle {...p} cx={12} cy={12} r={9} />
            <Polyline {...p} points="8 12 11 15 16 9" />
          </>
        );
      case 'github':
        return (
          <Path
            fill={c}
            d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"
          />
        );
      case 'key':
        return (
          <>
            <Circle {...p} cx={7.5} cy={15.5} r={4.5} />
            <Path {...p} d="M10.8 12.2L21 2M15 8l3 3M18 5l3 3" />
          </>
        );
      case 'terminal':
        return (
          <>
            <Polyline {...p} points="4 17 10 11 4 5" />
            <Line {...p} x1={12} y1={19} x2={20} y2={19} />
          </>
        );
      case 'sun':
        return (
          <>
            <Circle {...p} cx={12} cy={12} r={4} />
            <Path {...p} d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        );
      case 'moon':
        return <Path {...p} d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />;
      case 'folder':
        return <Path {...p} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />;
      case 'clone':
      case 'copy':
        return (
          <>
            <Rect {...p} x={9} y={9} width={12} height={12} rx={2} />
            <Path {...p} d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </>
        );
      case 'tag':
        return (
          <>
            <Path {...p} d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-8.2-8.2V4a2 2 0 0 1 2-2h8.4l8.2 8.2a2 2 0 0 1-.4 3.2z" />
            <Circle {...p} cx={7.5} cy={7.5} r={1.2} />
          </>
        );
      case 'cloud':
        return <Path {...p} d="M17.5 19a4.5 4.5 0 0 0 .5-9 7 7 0 0 0-13.5 2A4 4 0 0 0 6 19z" />;
      case 'commit':
        return (
          <>
            <Circle {...p} cx={12} cy={12} r={4} />
            <Line {...p} x1={2} y1={12} x2={8} y2={12} />
            <Line {...p} x1={16} y1={12} x2={22} y2={12} />
          </>
        );
      case 'file':
        return (
          <>
            <Path {...p} d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <Polyline {...p} points="14 2 14 8 20 8" />
          </>
        );
      case 'image':
        return (
          <>
            <Rect {...p} x={3} y={3} width={18} height={18} rx={2} />
            <Circle {...p} cx={8.5} cy={8.5} r={1.5} />
            <Polyline {...p} points="21 15 16 10 5 21" />
          </>
        );
      case 'binary':
        return (
          <>
            <Rect {...p} x={14} y={14} width={4} height={6} rx={2} />
            <Rect {...p} x={6} y={4} width={4} height={6} rx={2} />
            <Path {...p} d="M6 20h4M14 10h4M6 14h2v6M14 4h2v6" />
          </>
        );
      case 'trash':
        return (
          <>
            <Path {...p} d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
            <Path {...p} d="M10 11v6M14 11v6" />
          </>
        );
      case 'pin':
        return <Path {...p} d="M12 17v5M9 3h6l-1 7 3 2v2H7v-2l3-2z" />;
      case 'refresh':
        return (
          <>
            <Path {...p} d="M21 12a9 9 0 1 1-2.6-6.4" />
            <Polyline {...p} points="21 3 21 9 15 9" />
          </>
        );
      case 'list':
        return <Path {...p} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />;
      case 'tree':
        return (
          <>
            <Path {...p} d="M3 6h5M8 6v12M8 12h5M8 18h5" />
            <Rect {...p} x={13} y={10} width={8} height={4} rx={1} />
            <Rect {...p} x={13} y={16} width={8} height={4} rx={1} />
            <Rect {...p} x={3} y={4} width={5} height={4} rx={1} />
          </>
        );
      case 'columns':
        return (
          <>
            <Rect {...p} x={3} y={4} width={18} height={16} rx={2} />
            <Line {...p} x1={12} y1={4} x2={12} y2={20} />
          </>
        );
      case 'rows':
        return (
          <>
            <Rect {...p} x={3} y={4} width={18} height={16} rx={2} />
            <Line {...p} x1={3} y1={12} x2={21} y2={12} />
          </>
        );
      case 'history':
        return (
          <>
            <Path {...p} d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <Polyline {...p} points="3 3 3 8 8 8" />
            <Polyline {...p} points="12 7 12 12 15 14" />
          </>
        );
      case 'user':
        return (
          <>
            <Circle {...p} cx={12} cy={8} r={4} />
            <Path {...p} d="M4 21a8 8 0 0 1 16 0" />
          </>
        );
      case 'more':
        return (
          <>
            <Circle fill={c} cx={5} cy={12} r={1.6} />
            <Circle fill={c} cx={12} cy={12} r={1.6} />
            <Circle fill={c} cx={19} cy={12} r={1.6} />
          </>
        );
      case 'warning':
        return (
          <>
            <Path {...p} d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            <Path {...p} d="M12 9v4M12 17h.01" />
          </>
        );
      case 'info':
        return (
          <>
            <Circle {...p} cx={12} cy={12} r={9} />
            <Path {...p} d="M12 16v-4M12 8h.01" />
          </>
        );
      case 'undo':
        return (
          <>
            <Polyline {...p} points="9 14 4 9 9 4" />
            <Path {...p} d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </>
        );
      case 'home':
        return (
          <>
            <Path {...p} d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z" />
          </>
        );
      case 'sidebar':
        return (
          <>
            <Rect {...p} x={3} y={4} width={18} height={16} rx={2} />
            <Line {...p} x1={9} y1={4} x2={9} y2={20} />
          </>
        );
      case 'layers':
        return (
          <>
            <Path {...p} d="M12 3l9 5-9 5-9-5z" />
            <Path {...p} d="M3 13l9 5 9-5M3 17l9 5 9-5" />
          </>
        );
      case 'arrowUp':
        return <Path {...p} d="M12 19V5M5 12l7-7 7 7" />;
      case 'arrowDown':
        return <Path {...p} d="M12 5v14M5 12l7 7 7-7" />;
      case 'arrowRight':
        return <Path {...p} d="M5 12h14M12 5l7 7-7 7" />;
      case 'grip':
        return (
          <>
            <Circle fill={c} cx={9} cy={6} r={1.4} />
            <Circle fill={c} cx={15} cy={6} r={1.4} />
            <Circle fill={c} cx={9} cy={12} r={1.4} />
            <Circle fill={c} cx={15} cy={12} r={1.4} />
            <Circle fill={c} cx={9} cy={18} r={1.4} />
            <Circle fill={c} cx={15} cy={18} r={1.4} />
          </>
        );
      case 'eye':
        return (
          <>
            <Path {...p} d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
            <Circle {...p} cx={12} cy={12} r={3} />
          </>
        );
      case 'lock':
        return (
          <>
            <Rect {...p} x={4} y={11} width={16} height={10} rx={2} />
            <Path {...p} d="M8 11V7a4 4 0 0 1 8 0v4" />
          </>
        );
      case 'filter':
        return <Path {...p} d="M3 5h18l-7 8.5V19l-4 2v-7.5z" />;
      case 'external':
        return (
          <>
            <Path {...p} d="M14 4h6v6" />
            <Path {...p} d="M20 4l-9 9" />
            <Path {...p} d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
          </>
        );
      case 'stop':
        return <Rect {...p} x={6} y={6} width={12} height={12} />;
      case 'expand':
        return <Path {...p} d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />;
      case 'collapse':
        return <Path {...p} d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" />;
      case 'link':
        return (
          <>
            <Path {...p} d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
            <Path {...p} d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
          </>
        );
      case 'spinner':
        return <Path {...p} d="M12 3a9 9 0 1 0 9 9" />;
      case 'keyboard':
        return (
          <>
            <Rect {...p} x={2} y={6} width={20} height={12} rx={2} />
            <Path {...p} d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
          </>
        );
      case 'edit':
        return (
          <>
            <Path {...p} d="M12 20h9" />
            <Path {...p} d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </>
        );
      case 'agent':
        return (
          <>
            <Path {...p} d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
            <Path {...p} d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
            <Path {...p} d="M5 16l.6 1.4L7 18l-1.4.6L5 20l-.6-1.4L3 18l1.4-.6z" />
          </>
        );
      case 'send':
        return <Path {...p} d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />;
      case 'rotate':
        return (
          <>
            <Path {...p} d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <Polyline {...p} points="3 3 3 8 8 8" />
          </>
        );
    }
  })();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {body}
    </Svg>
  );
}
