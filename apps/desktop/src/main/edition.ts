import { app } from 'electron';

/**
 * Which edition this build is.
 *
 * There is no runtime flag for it — the editions are made by what does and
 * does not get synced into the public repo, so the only thing that differs in
 * a finished build is its identity. The package name is that identity, and it
 * is also what the installer derives its folder from, so it is the one thing
 * guaranteed to be right in both.
 *
 * This matters for the remote link. A Pro front end pointed at a Free host
 * shows Design and Video tabs whose channels do not exist over there, and
 * every one of them answers "Unknown channel" — a UI full of controls that
 * cannot work. The reverse is quieter but still wrong: a Free front end hides
 * panels the host is perfectly able to run, so half the machine is invisible.
 *
 * Refusing the pair outright is kinder than either. It fails once, at connect
 * time, with a sentence saying what to do, instead of failing per-panel
 * forever.
 */
export type Edition = 'pro' | 'free';

export function edition(): Edition {
  return /(^|[-_])pro$/i.test(app.getName().trim()) ? 'pro' : 'free';
}
