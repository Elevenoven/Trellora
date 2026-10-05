interface CollapsibleAiContentProps {
  children: React.ReactNode;
  resetKey: string;
  collapsedHeight?: number;
}

export default function CollapsibleAiContent({ children }: CollapsibleAiContentProps) {
  return <div className="collapsible-ai-content"><div className="collapsible-ai-content-body expanded">{children}</div></div>;
}
