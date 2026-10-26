import React from 'react';
import { View } from 'react-native';
import { PickOption, showPicker } from '../state/store';
import { FONT, useTheme } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { PressScale, Txt } from '../ui/primitives';

/**
 * A dialog field with a dropdown of choices (remote, branch), as in Fork's Fetch / Pull / Push windows. Long lists
 * get a filter. The list is drawn above the dialog, so it is never clipped by it.
 */
export function Select({ value, options, onChange, icon, placeholder, filter, disabled, testID, showHint = true }: {
  value: string;
  options: PickOption[];
  onChange: (v: string) => void;
  icon?: IconName;
  placeholder?: string;
  /** a filter field in the dropdown; on by default for more than 12 choices */
  filter?: boolean;
  disabled?: boolean;
  testID?: string;
  /** the chosen option's hint in the field too (off for narrow fields: the list still shows it) */
  showHint?: boolean;
}) {
  const t = useTheme();
  const current = options.find((o) => o.value === value);
  return (
    <PressScale
      disabled={disabled || options.length === 0}
      scaleTo={1}
      outerStyle={{ flex: 1, minWidth: 0 }}
      // a dropdown: its fill, no outline
      style={{ flexDirection: 'row', alignItems: 'center', height: 26, paddingHorizontal: 8, backgroundColor: t.raised }}
      hoverStyle={{ backgroundColor: t.hover }}
      onPressAt={(a) => showPicker({ anchor: a, options, value, onPick: onChange, filter: filter ?? options.length > 12, testID: testID ? `${testID}-list` : undefined })}
      label={placeholder}
      testID={testID}
    >
      {icon && <Icon name={icon} size={12} color={t.textMuted} />}
      <View style={{ flex: 1, minWidth: 0, marginLeft: icon ? 6 : 0, flexDirection: 'row', alignItems: 'baseline' }}>
        {/* the name keeps its room; the hint (a URL) gives way */}
        <Txt size={FONT.md} numberOfLines={1} color={current ? t.text : t.textFaint} style={{ flexShrink: 0, maxWidth: '100%' }}>
          {current?.label ?? (value || placeholder || '—')}
        </Txt>
        {showHint && current?.hint ? (
          <Txt size={FONT.xs} faint numberOfLines={1} style={{ marginLeft: 8, flexShrink: 1, minWidth: 0 }}>
            {current.hint}
          </Txt>
        ) : null}
      </View>
      <Txt size={FONT.xs} color={t.textMuted} style={{ marginLeft: 6 }}>
        ▾
      </Txt>
    </PressScale>
  );
}
