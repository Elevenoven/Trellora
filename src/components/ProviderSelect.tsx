import { Box, Group, Select, type SelectProps } from '@mantine/core';
import { Check } from 'lucide-react';
import ProviderIcon from './ProviderIcon';

/** 厂商选择项与已选值使用同一图标，保留键盘选择与选中标记。 */
export default function ProviderSelect(props: Omit<SelectProps, 'renderOption' | 'leftSection'>) {
  return <Select
    {...props}
    leftSection={props.value ? <ProviderIcon provider={props.value} size={18} /> : undefined}
    renderOption={({ option, checked }) => <Group gap="sm" wrap="nowrap" style={{ width: '100%' }}>
      <ProviderIcon provider={option.value} size={20} />
      <Box component="span" style={{ flex: 1, minWidth: 0 }}>{option.label}</Box>
      {checked ? <Check size={14} aria-hidden="true" /> : null}
    </Group>}
  />;
}
