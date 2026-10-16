export interface ResultItem {
  id: string;
  path: string;
  root: string;
  matches: number[];
}

export interface MatchLocation {
  line: number;
  text: string;
  matches: readonly number[];
}

export interface ContentMatch {
  id: string;
  uri: string;
  path: string;
  root: string;
  location: MatchLocation;
  diff?: DiffTarget;
}

export interface DiffTarget {
  left: string;
  right: string;
  title: string;
  side: 'added' | 'removed';
  modifiedLine: number;
  emptyLeft: boolean;
  emptyRight: boolean;
  hunk?: string;
  metadataOnly?: boolean;
}
