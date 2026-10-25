'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { studentText } from '@/i18n/student';
import { FRAME_ASPECT, type DocProfile } from '@/lib/scan/constants';

/**
 * Optional live camera (getUserMedia) with an on-screen frame guide shaped to the
 * document (design §6.2 screen 4). Captures the full-resolution video frame.
 * The plain `<input capture>` path remains the primary, most compatible option.
 */
export function CameraView({ profile, onCapture, onClose }: { profile: DocProfile; onCapture: (blob: Blob) => void; onClose: () => void }) {
  const c = studentText.capture;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        setReady(true);
      } catch {
        setError(c.cameraDenied);
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [c.cameraDenied]);

  function capture() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    canvas.toBlob((b) => b && onCapture(b), 'image/jpeg', 0.95);
  }

  // Frame guide: the document's aspect, oriented as it will be held.
  const aspect = FRAME_ASPECT[profile.frame];
  const guideAspect = profile.orientation === 'landscape' ? Math.max(aspect, 1 / aspect) : Math.min(aspect, 1 / aspect);

  return (
    <div role="dialog" aria-modal="true" aria-label={c.cameraTitle} className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between p-3">
        <p className="font-semibold">{c.cameraTitle}</p>
        <button type="button" onClick={onClose} aria-label={c.cameraClose} className="grid size-12 place-items-center rounded-full hover:bg-white/10">
          <X aria-hidden className="size-6" />
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className="absolute inset-0 size-full object-cover" />
        {ready && (
          <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center p-6">
            <div
              className="w-full max-w-[90%] rounded-md border-4 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
              style={{ aspectRatio: String(guideAspect), maxHeight: '80%' }}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="absolute inset-x-4 top-4 rounded-sm bg-white p-3 text-ink">
            {error}
          </p>
        )}
      </div>
      <div className="space-y-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p className="text-center text-sm text-white/85">
          {c.tipCloser} {c.tipSteady} {c.tipGlare}
        </p>
        <Button fullWidth size="lg" onClick={capture} disabled={!ready} icon={<Camera aria-hidden className="size-5" />}>
          {c.cameraCapture}
        </Button>
      </div>
    </div>
  );
}
