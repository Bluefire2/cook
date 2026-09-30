import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';

const OPENER_SELECTOR = 'button, a, input, textarea, select';

let lastOpener: HTMLElement | null = null;

function recordOpener(event: Event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const opener = target.closest(OPENER_SELECTOR);
  if (opener instanceof HTMLElement) lastOpener = opener;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', recordOpener, true);
  document.addEventListener('click', recordOpener, true);
}

function DialogFrame({
  onClose,
  dismissible,
  backdropLabel,
  overlayClassName,
  panelClassName,
  labelId,
  headingId,
  onLabel,
  openerRef,
  panelRef,
  children,
}: {
  onClose: () => void;
  dismissible: boolean;
  backdropLabel: string;
  overlayClassName: string;
  panelClassName: string;
  labelId: string | undefined;
  headingId: string;
  onLabel: (id: string | undefined) => void;
  openerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let opener: HTMLElement | null = null;
    if (lastOpener && !shell.contains(lastOpener)) opener = lastOpener;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement &&
      !shell.contains(active)
    ) {
      opener = active;
    }
    openerRef.current = opener;
  }, [openerRef]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const heading = panel.querySelector('h1, h2, h3');
    if (!(heading instanceof HTMLElement)) {
      onLabel(undefined);
      return;
    }
    if (!heading.id) heading.id = headingId;
    onLabel(heading.id);
  }, [children, headingId, onLabel, panelRef]);

  const focusOnOpen = (event: Event) => {
    event.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    for (const candidate of panel.querySelectorAll('[autofocus]')) {
      if (candidate instanceof HTMLElement && !candidate.matches(':disabled')) {
        candidate.focus();
        return;
      }
    }
    panel.focus({ preventScroll: true });
  };

  const restoreOpener = (event: Event) => {
    event.preventDefault();
    const opener = openerRef.current;
    if (opener?.isConnected) opener.focus();
  };

  const onEscape = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (dismissible) onClose();
  };

  const swallowOutside = (event: { preventDefault(): void }) => {
    event.preventDefault();
  };

  return (
    <div ref={shellRef} className={overlayClassName} style={{ pointerEvents: 'auto' }}>
      <button
        type="button"
        className="flex-1 bg-black/40"
        aria-label={backdropLabel}
        tabIndex={-1}
        disabled={!dismissible}
        onClick={onClose}
      />
      <Dialog.Content
        ref={panelRef}
        className={panelClassName}
        aria-modal={true}
        aria-labelledby={labelId}
        onOpenAutoFocus={focusOnOpen}
        onCloseAutoFocus={restoreOpener}
        onEscapeKeyDown={onEscape}
        onPointerDownOutside={swallowOutside}
        onInteractOutside={swallowOutside}
      >
        {children}
      </Dialog.Content>
    </div>
  );
}

export default function DialogShell({
  onClose,
  dismissible = true,
  backdropLabel,
  overlayClassName,
  panelClassName,
  children,
}: {
  onClose: () => void;
  dismissible?: boolean;
  backdropLabel: string;
  overlayClassName: string;
  panelClassName: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const [labelId, setLabelId] = useState<string | undefined>(undefined);

  return (
    <Dialog.Root
      open
      modal
      onOpenChange={(next) => {
        if (!next && dismissible) onClose();
      }}
    >
      <Dialog.Portal>
        <DialogFrame
          onClose={onClose}
          dismissible={dismissible}
          backdropLabel={backdropLabel}
          overlayClassName={overlayClassName}
          panelClassName={panelClassName}
          labelId={labelId}
          headingId={headingId}
          onLabel={setLabelId}
          openerRef={openerRef}
          panelRef={panelRef}
        >
          {children}
        </DialogFrame>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
