'use client';

import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * Toast host. The theme follows the `.dark` class that the theme toggle writes on <html>,
 * so no extra theme provider dependency is needed.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="top-right"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
