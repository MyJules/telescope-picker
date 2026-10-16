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
}
