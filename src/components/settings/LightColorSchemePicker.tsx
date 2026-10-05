import { UnstyledButton } from '@mantine/core';
import { Check } from 'lucide-react';
import { LIGHT_COLOR_SCHEMES, getColorScheme, type LightColorScheme } from '../../../shared/lightColorSchemes';
import { t } from '../../i18n';
import './LightColorSchemePicker.css';

interface Props {
  value: LightColorScheme;
  theme: 'light' | 'dark';
  onChange: (value: LightColorScheme) => void;
}

export default function LightColorSchemePicker({ value, theme, onChange }: Props) {
  return (
    <div className="light-color-picker" role="group" aria-label={t('界面配色')}>
      {LIGHT_COLOR_SCHEMES.map(({ id }) => {
        const scheme = getColorScheme(theme, id);
        return (
          <UnstyledButton
            key={scheme.id}
            className="light-color-choice"
            data-light-color-choice={scheme.id}
            aria-label={t(scheme.label)}
            aria-pressed={value === scheme.id}
            onClick={() => onChange(scheme.id)}
          >
            <span className="light-color-choice-swatch" style={{ backgroundColor: scheme.accent, color: theme === 'dark' ? scheme.canvas : '#ffffff' }}>
              {value === scheme.id && <Check size={16} strokeWidth={2.5} aria-hidden="true" />}
            </span>
            <span>{t(scheme.label)}</span>
          </UnstyledButton>
        );
      })}
    </div>
  );
}
