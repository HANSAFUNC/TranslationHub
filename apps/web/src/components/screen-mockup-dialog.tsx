'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, ImageIcon, Monitor, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { StatusBadge } from '@/components/status-badge';
import { useAsync, timeAgo } from '@/components/use-async';
import { fetchObjectUrl, get, type MockupDetail, type MockupMarker, type MockupSummary } from '@/lib/api';
import { localeDisplayName } from '@localehub/contracts/locale';
import { cn } from '@/lib/utils';

/**
 * The 90% detail view: the screen on the left, the translations on the right.
 *
 * A translation key says what a string is, never where it lives, so `checkout.pay_now` reaches a
 * translator as three words with no button under them. This dialog puts back the missing half. The
 * sketch on the left is what the caller saw; each numbered box is a key's text at its position on
 * that screen. The list on the right is the same keys with their translations in the locale being
 * reviewed.
 *
 * The two panes are linked both ways, which is the whole point: click a marker and its rows scroll
 * into view and light up; click a row and its markers light up. Numbers are what tie them together —
 * the same number appears on the box and on the row.
 */

/**
 * Load a binary resource as an object URL, revoking it when the source changes.
 *
 * `<img src>` pointing straight at the API is not reliable (the credential and the CORS rules depend
 * on the deployment), so the image travels the same path as every other request. What comes back is
 * an object URL for raster sketches and a data URL for SVG ones (see `fetchObjectUrl`); only the
 * former needs releasing, and not releasing it leaks the whole blob for the life of the tab, so a
 * reviewer clicking through ten screens would leak ten of them.
 */
/** Only object URLs are ours to release; a `data:` URL is a string with nothing to free. */
function revokeIfObjectUrl(url: string | null): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

function useObjectUrl(path: string | null): { url: string | null; error: unknown } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    if (!path) {
      setUrl(null);
      return;
    }
    void (async () => {
      try {
        created = await fetchObjectUrl(path);
        if (revoked) {
          revokeIfObjectUrl(created);
          return;
        }
        setUrl(created);
        setError(null);
      } catch (err) {
        if (!revoked) setError(err);
      }
    })();
    return () => {
      revoked = true;
      revokeIfObjectUrl(created);
      setUrl(null);
    };
  }, [path]);

  return { url, error };
}

/**
 * The identity the two panes agree on: a key plus its namespace.
 *
 * Nothing invisible in the separator. The DOM attributes below are read back with `CSS.escape`, which
 * replaces a NUL byte with U+FFFD — so an identity built with `\u0000` matched no element and every
 * click through `querySelector` silently did nothing. A character a namespace cannot contain (it is a
 * `.strings` table name) is both safe in a selector and readable in the inspector.
 */
function markerKey(marker: { key: string; namespace: string }): string {
  return `${marker.namespace}\u001f${marker.key}`;
}

export function ScreenMockupDialog({
  projectId,
  open,
  onOpenChange,
  locales,
  sourceLocale,
  defaultLocale,
  focusEntryId,
  focusKey,
  focusNamespace,
  onOpenInEditor,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locales: { code: string; name: string }[];
  sourceLocale: string | undefined;
  /** The locale the editor is filtered to, so the dialog opens on the same one. */
  defaultLocale: string | null;
  /** The entry selected in the editor, focused when the dialog opens. */
  focusEntryId: string | null;
  focusKey: string | null;
  /** Namespace of the focused key: (namespace, key) is the identity, a bare key is not. */
  focusNamespace?: string | null;
  /** "Open in the editor": closes the dialog and lands on that entry. */
  onOpenInEditor: (entry: { entryId: string; value: string }) => void;
}) {
  const [mockupId, setMockupId] = useState<string | null>(null);
  const [locale, setLocale] = useState<string | null>(defaultLocale);
  const [selected, setSelected] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const targetLocales = useMemo(() => locales.filter((entry) => entry.code !== sourceLocale), [locales, sourceLocale]);

  // Reset on each open: the dialog is opened for a specific entry, and the state from the last visit
  // (a screen the reader has since left, a locale they were comparing) is noise, not a preference.
  useEffect(() => {
    if (!open) return;
    setSelected(null);
    // Also forgotten: the screen. Keeping the previous choice meant the list refetched with the new
    // key but the dialog stayed on the screen the reader looked at last time, so the containsKey
    // answer it had just asked for was ignored from the second open onwards.
    setMockupId(null);
    setLocale((current) => {
      if (defaultLocale && targetLocales.some((entry) => entry.code === defaultLocale)) return defaultLocale;
      if (current && targetLocales.some((entry) => entry.code === current)) return current;
      return targetLocales[0]?.code ?? null;
    });
  }, [open, defaultLocale, targetLocales]);

  // `containsKey` answers "which screen is the entry I have selected on?" — the dialog should open on
  // that one rather than on whichever sketch was uploaded last.
  const { data: mockups, error: listError, loading: listLoading } = useAsync(
    () =>
      open
        ? get<MockupSummary[]>(
            `/projects/${projectId}/mockups${
              focusKey ? `?key=${encodeURIComponent(focusKey)}&namespace=${encodeURIComponent(focusNamespace ?? '')}` : ''
            }`,
          )
        : Promise.resolve([]),
    [projectId, open, focusKey, focusNamespace],
  );

  useEffect(() => {
    if (!open || !mockups?.length) {
      if (open && mockups && !mockups.length) setMockupId(null);
      return;
    }
    setMockupId((current) => {
      if (current && mockups.some((mockup) => mockup.id === current)) return current;
      return (mockups.find((mockup) => mockup.containsKey) ?? mockups[0]!).id;
    });
  }, [open, mockups]);

  const {
    data: detail,
    error: detailError,
    loading: detailLoading,
  } = useAsync(
    () =>
      open && mockupId
        ? get<MockupDetail>(`/projects/${projectId}/mockups/${mockupId}${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`)
        : Promise.resolve(null),
    [projectId, open, mockupId, locale],
  );

  const { url: imageUrl, error: imageError } = useObjectUrl(open && detail ? detail.mockup.imagePath : null);

  const markers = useMemo(() => detail?.markers ?? [], [detail]);

  /**
   * The sketch's box, sized so it *is* the painted image — which is what makes percentage-positioned
   * markers land on the right pixels.
   *
   * Two earlier attempts failed in opposite directions, both measured in a real browser:
   *
   *   - an `inline-block` wrapper with `max-w-full` on the image inside it collapses to nothing: a
   *     percentage max-width resolves against a shrink-to-fit parent whose width is decided by the
   *     image, and browsers settle that circularity at zero. A 375×812 sketch painted 2×2 px with all
   *     seven markers piled into it.
   *   - `height: 100%` + `aspect-ratio` + `max-w-full` fits a portrait sketch exactly but stretches a
   *     landscape one: the height stays definite when `max-width` clamps the width, so a 1440×900
   *     sketch painted 655×778 — ratio 0.84 instead of 1.60, every web screenshot squashed.
   *
   * What works is choosing the width from the pane's own box, in both directions at once: the pane is
   * a size container, so `100cqh` and `100%` are its height and width, and `min()` picks whichever
   * side runs out first. The height then follows from `aspect-ratio`, so the ratio is never broken.
   */
  const sketch = useMemo(() => {
    const width = detail?.mockup.width;
    const height = detail?.mockup.height;
    if (!width || !height) return null;
    const ratio = width / height;
    return {
      aspectRatio: `${width} / ${height}`,
      // `100%` is the pane's content width, `100cqh` its content height.
      width: `min(100%, calc(100cqh * ${ratio}))`,
    };
  }, [detail?.mockup.width, detail?.mockup.height]);

  /** Which key the panes agree is current: the marker list, or the entry the editor had selected. */
  const activeKey = useMemo(() => {
    if (selected) return selected;
    if (focusKey) {
      // Identity is key *and* namespace: comparing the key name alone picked a marker in another
      // namespace on a project whose iOS keys repeat across `.strings` tables, and highlighted the
      // wrong row. Done here rather than through the contract's `markerMatchesKey` because the web
      // bundle imports only the zod-free contract subpaths, and pulling that module in for two lines
      // would ship zod to the browser.
      const namespace = focusNamespace ?? '';
      const match = markers.find((marker) => marker.key === focusKey && (marker.namespace || '') === namespace);
      if (match) return markerKey(match);
    }
    const focused = markers.find((marker) => marker.entry?.entryId === focusEntryId);
    return focused ? markerKey(focused) : null;
  }, [selected, focusKey, focusNamespace, focusEntryId, markers]);

  const select = useCallback((identity: string) => setSelected(identity), []);

  // Both directions scroll: a marker clicked on the left has to bring its row into view, and a row
  // clicked on the right has to bring its box into view. Only the highlighted half is scrolled, so
  // clicking never yanks the pane the reader is already looking at.
  useEffect(() => {
    if (!activeKey) return;
    rowRefs.current.get(activeKey)?.scrollIntoView({ block: 'nearest' });
    document.querySelector(`[data-marker="${CSS.escape(activeKey)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The width is stated twice on purpose: `DialogContent` ships `sm:max-w-lg`, so a plain
          `max-w-[94vw]` would lose to it above 640px and pin the dialog to 32rem — the opposite of
          the 90% this view exists for. */}
      <DialogContent
        className="flex h-[92svh] w-[94vw] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:h-[90svh] sm:w-[90vw] sm:max-w-[90vw]"
      >
        <DialogHeader className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-3 border-b px-6 py-4 pr-14 text-left">
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ImageIcon className="size-4" />
              界面草图
            </DialogTitle>
            <DialogDescription className="truncate">
              {detail
                ? `${detail.mockup.name} · ${detail.mockup.platform} · 草图语言 ${detail.mockup.locale}${
                    detail.mockup.width ? ` · ${detail.mockup.width}×${detail.mockup.height}` : ''
                  } · 更新于 ${timeAgo(detail.mockup.updatedAt)}`
                : '左侧是调用端上传的界面草图，右侧是对应译文；点标记或条目会互相跳转'}
            </DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mockups && mockups.length > 1 ? (
              <Select value={mockupId ?? undefined} onValueChange={(value) => { setMockupId(value); setSelected(null); }}>
                <SelectTrigger size="sm" className="w-[180px]">
                  <SelectValue placeholder="选择界面" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {mockups.map((mockup) => (
                      <SelectItem key={mockup.id} value={mockup.id}>
                        {mockup.name} · {mockup.platform}
                        {mockup.containsKey ? ' · 含当前 Key' : ''}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            <Select
              value={locale ?? undefined}
              onValueChange={(value) => { setLocale(value); setSelected(null); }}
            >
              <SelectTrigger size="sm" className="w-[190px]">
                <SelectValue placeholder="选择目标语言" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {targetLocales.map((entry) => (
                    <SelectItem key={entry.code} value={entry.code}>
                      {entry.code} · {entry.name || localeDisplayName(entry.code)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </DialogHeader>

        <ErrorAlert error={listError ?? detailError ?? imageError} />

        {!listLoading && mockups && mockups.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<ImageIcon />}
              title="这个项目还没有界面草图"
              description={
                <>
                  草图由能看见界面的一方上传：Agent 在仓库里画出界面（SVG 最省事），用 Remote MCP 的{' '}
                  <span className="font-mono">upload_screen_mockup</span> 连同每个 Key 的位置一起传上来，
                  标出文案在界面上的位置。坐标是相对图片的比例（0~1），不是像素。
                </>
              }
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {/* Left: the sketch. Scrolls on its own, because a phone-shaped screen is taller than the
                dialog and the reader still needs to reach its bottom half. */}
            <div className="bg-muted/30 flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-4 [container-type:size]">
              {detailLoading || !detail ? (
                <Skeleton className="h-64 w-full max-w-xl" />
              ) : (
                // Sized from the pane (`sketch`), so the box is exactly the painted image at any
                // orientation; `max-h-full` is the belt to that braces.
                <div
                  // The checkerboard is the pane's ground, not decoration: most sketches are light
                  // wireframes, and on a dark surface their edges and thin outlines simply vanish —
                  // a white sheet on a neutral ground reads as a sheet at any theme.
                  className="relative max-h-full max-w-full rounded-md bg-white bg-[repeating-conic-gradient(#e4e4e7_0_25%,#ffffff_0_50%)] bg-[length:16px_16px]"
                  style={sketch ? { aspectRatio: sketch.aspectRatio, width: sketch.width } : undefined}
                >
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt={`${detail.mockup.name} 界面草图`}
                      className={
                        sketch
                          ? 'absolute inset-0 h-full w-full rounded-md border shadow-sm'
                          : 'block h-auto max-h-[76svh] w-auto rounded-md border shadow-sm'
                      }
                    />
                  ) : (
                    <Skeleton className="h-64 w-96" />
                  )}
                  <div className="absolute inset-0">
                    {markers.map((marker, index) => {
                      const identity = markerKey(marker);
                      const isActive = identity === activeKey;
                      const untranslated = marker.source !== null && (!marker.entry || !marker.entry.value);
                      // A caller may send `width` without `height` (or the reverse). The box is then
                      // anchored by its top-left corner, which is what the percentages mean; only a
                      // marker with neither dimension is a point, and only a point is centred.
                      const anchored = Boolean(marker.width || marker.height);
                      return (
                        <button
                          key={marker.id}
                          type="button"
                          data-marker={identity}
                          onClick={() => select(identity)}
                          title={`${marker.key}${marker.text ? `\n草图：${marker.text}` : ''}`}
                          style={{
                            left: `${marker.x * 100}%`,
                            top: `${marker.y * 100}%`,
                            width: marker.width ? `${marker.width * 100}%` : undefined,
                            height: marker.height ? `${marker.height * 100}%` : undefined,
                          }}
                          className={cn(
                            'absolute rounded-[3px] border text-left transition',
                            anchored ? 'flex items-start' : 'size-4 -translate-x-1/2 -translate-y-1/2 rounded-full',
                            // Every marker keeps a translucent fill: the point of the overlay is to show
                            // where the text sits, and an outline-only box disappears over a wireframe
                            // whose own borders are the same colour.
                            isActive
                              ? 'border-primary bg-primary/30 ring-primary ring-2'
                              : untranslated
                                ? 'border-amber-500 bg-amber-400/30 hover:bg-amber-400/45'
                                : 'border-primary/70 bg-primary/20 hover:bg-primary/35',
                          )}
                        >
                          <span
                            className={cn(
                              'rounded-[3px] px-1 text-[10px] font-medium leading-4 tabular-nums',
                              isActive ? 'bg-primary text-primary-foreground' : 'bg-primary/80 text-primary-foreground',
                            )}
                          >
                            {index + 1}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Right: the same keys, with the translation for the locale under review. */}
            <div className="flex min-h-0 flex-1 flex-col border-t lg:max-w-[38rem] lg:border-l lg:border-t-0">
              <div className="text-muted-foreground flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-xs">
                <span>
                  {markers.length} 个标记 · 目标语言{' '}
                  <span className="font-mono">{locale ? localeDisplayName(locale) : '—'}</span>
                </span>
                <span className="hidden sm:inline">点标记 ↔ 点条目，两侧互相跳转</span>
              </div>
              {detailLoading || !detail ? (
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-16" />
                  ))}
                </div>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <ul className="flex flex-col divide-y">
                    {markers.map((marker, index) => (
                      <MarkerRow
                        key={marker.id}
                        index={index}
                        marker={marker}
                        screenPlatform={detail.mockup.platform}
                        active={markerKey(marker) === activeKey}
                        onSelect={() => select(markerKey(marker))}
                        onOpenInEditor={onOpenInEditor}
                        register={(node) => {
                          if (node) rowRefs.current.set(markerKey(marker), node);
                          else rowRefs.current.delete(markerKey(marker));
                        }}
                      />
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MarkerRow({
  index,
  marker,
  screenPlatform,
  active,
  onSelect,
  onOpenInEditor,
  register,
}: {
  index: number;
  marker: MockupMarker;
  screenPlatform: string;
  active: boolean;
  onSelect: () => void;
  onOpenInEditor: (entry: { entryId: string; value: string }) => void;
  register: (node: HTMLElement | null) => void;
}) {
  const missingKey = marker.source === null;
  const untranslated = !missingKey && (!marker.entry || !marker.entry.value);
  // The sketch is drawn from one language; if a marker's text disagrees with the platform's source
  // text, the screen may have moved on since the upload. Worth showing, never worth hiding.
  const textDrift = Boolean(marker.text && marker.source && marker.text !== marker.source);

  return (
    <li
      ref={register}
      // Named for the same reason `data-marker` is: the browser check drives these two panes by
      // clicking them, and "the third <li>" is not a stable way to find a row.
      data-marker-row={markerKey(marker)}
      onClick={onSelect}
      className={cn('cursor-pointer px-4 py-3 transition-colors', active ? 'bg-accent/70' : 'hover:bg-muted/50')}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium tabular-nums',
            active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-xs">{marker.key}</span>
            {marker.namespace ? <Badge variant="muted" className="text-[10px]">{marker.namespace}</Badge> : null}
            {missingKey ? (
              <Badge variant="outline" className="text-[10px]">平台没有这个 Key</Badge>
            ) : marker.platform !== screenPlatform ? (
              // The key exists, just not on the platform this screen claims. Shown rather than
              // silently resolved: it usually means the sketch or the import named the wrong 端.
              <Badge variant="warning" className="text-[10px]">
                Key 在 {marker.platform}，不在 {screenPlatform}
              </Badge>
            ) : marker.entry ? (
              <StatusBadge status={marker.entry.status} />
            ) : (
              <Badge variant="outline" className="text-[10px]">该语言还没有条目</Badge>
            )}
          </div>

          <div className="mt-1 flex flex-col gap-0.5 text-sm">
            {marker.source ? <div className="text-muted-foreground truncate">{marker.source}</div> : null}
            <div className={cn('break-words', untranslated ? 'text-muted-foreground italic' : 'font-medium')}>
              {marker.entry?.value || (missingKey ? '—' : '未翻译')}
            </div>
          </div>

          {textDrift ? (
            <div className="text-muted-foreground mt-1 text-xs">草图里写的是「{marker.text}」，与平台原文不一致</div>
          ) : null}

          <div className="mt-2 flex items-center gap-2">
            {marker.entry ? (
              <Button
                type="button"
                variant={active ? 'default' : 'outline'}
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenInEditor({ entryId: marker.entry!.entryId, value: marker.entry!.value });
                }}
              >
                <Pencil data-icon="inline-start" />
                在编辑器中打开
              </Button>
            ) : (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <ExternalLink className="size-3" />
                导入该 Key 后即可编辑
              </span>
            )}
            {marker.note ? <span className="text-muted-foreground truncate text-xs">{marker.note}</span> : null}
          </div>
        </div>
      </div>
    </li>
  );
}

/** The button the editor puts in its header. Lives here so the two stay in step. */
export function ScreenMockupButton({ count, onClick }: { count: number | null; onClick: () => void }) {
  return (
    <Button variant="outline" onClick={onClick}>
      <Monitor />
      界面草图
      {count ? <Badge variant="muted" className="ml-1 text-[10px]">{count}</Badge> : null}
    </Button>
  );
}
