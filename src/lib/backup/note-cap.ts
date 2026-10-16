/**
 * The longest task note, in UTF-16 code units (`String.length`). That is the unit an HTML `maxlength` counts, so the
 * note field, the timeline store and a backup file's validator all agree on exactly which notes are allowed. It lives
 * alone, importing nothing, so the note field does not pull the backup file's size arithmetic into the app's shared
 * chunk.
 */
export const MAX_NOTE_UNITS = 100_000;
