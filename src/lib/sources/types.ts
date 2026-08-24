/** Public-facing shapes for the About sources index. Only fields safe to show on a public page - the
 *  registry's internal legal-record fields (hashes, capture paths, reviewer, license/terms notes) never
 *  reach these types. */

/** The clean publisher label shown to users. DoD is the statutory name (EO 14347 makes "Department of
 *  War" a secondary alias only); TSP is the public name for the FRTIB-operated plan. */
export type Publisher = 'VA' | 'DoD' | 'DOL' | 'TSP';

/** One official agency web page: a titled outbound link with its publisher. */
export type PublicSource = { title: string; url: string; publisher: Publisher };

/** One TAP curriculum guide. No url of its own - every guide lives in the shared TAP library. */
export type TapGuide = { title: string; publisher: Publisher };

/** The whole index the About page renders: agency pages, plus the TAP guides behind one shared link. */
export type SourcesIndex = {
	agency: PublicSource[];
	tapLibraryUrl: string;
	tapGuides: TapGuide[];
};
