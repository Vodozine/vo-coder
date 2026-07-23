import vodoUrl from '../assets/vodo.png';

/** Vodo himself — the mascot portrait as the in-app logo mark. */
export function VodoMark({ size = 24 }: { size?: number }) {
  return (
    <img
      src={vodoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden
      className="vodo-mark"
      draggable={false}
    />
  );
}
