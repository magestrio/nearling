/** design/ds/components.js 0.47 › Facts: inline semantic label–value pairs. */
export function Facts({ items, size = 'body' }: { items: Array<{ label: string; value: string | number }>; size?: 'body' | 'body-strong' | 'small' }) {
  return <dl className={`ds-facts type-${size}`}>
    {items.map((item, i) => <div className="ds-facts__pair" key={i}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
  </dl>;
}
