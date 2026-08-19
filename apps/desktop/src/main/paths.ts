import { app } from 'electron';

/**
 * Where this install keeps its things.
 *
 * Electron answers both of these, and on a desktop that is the right answer.
 * In a container it is not: there is no Windows "known folder" to resolve, and
 * more to the point the two directories need to be mount points, so a
 * container can be destroyed and rebuilt without taking the projects and the
 * chat history with it.
 *
 * So the environment wins when it has an opinion, and Electron answers when it
 * does not. On every existing install nothing changes at all.
 */

/** Config, chats, memory, secrets — everything the app owns about itself. */
export function userDataDir(): string {
  const override = process.env.VO_DATA_DIR?.trim();
  if (override) return override;
  return app.getPath('userData');
}

/**
 * Where the user's own work goes.
 *
 * app.getPath('documents') THROWS when Windows cannot resolve the known
 * folder — OneDrive Known Folder Move part-way through, a redirected shell
 * folder — and an unguarded call here would take startup down with it. userData
 * never throws, so it is the floor.
 */
export function documentsDir(): string {
  const override = process.env.VO_DOCUMENTS_DIR?.trim();
  if (override) return override;
  for (const key of ['documents', 'home'] as const) {
    try {
      return app.getPath(key);
    } catch {
      /* try the next known folder */
    }
  }
  return app.getPath('userData');
}
