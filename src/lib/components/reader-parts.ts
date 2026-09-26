// The reader's page view, pager and Save, loaded as one file: they are only ever used together, and only once a
// served document opens, so one download carries them and no page pays for them up front.
export { default as SourceDocument } from './SourceDocument.svelte';
export { default as DocumentPager } from './DocumentPager.svelte';
export { default as DocumentSave } from './DocumentSave.svelte';
