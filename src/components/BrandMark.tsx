import brandIconUrl from '../../build/icon.svg';

interface BrandMarkProps {
  size?: number;
}

/** 统一使用知识织结 SVG，让界面徽标与桌面图标保持同一图形。 */
export default function BrandMark({ size = 16 }: BrandMarkProps) {
  return (
    <img
      src={brandIconUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block' }}
    />
  );
}
