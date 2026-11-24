// All overlay geometry is in "view space": PDF points (1/72 inch), origin at the
// top-left of the page *as the user sees it* (after rotation), y pointing down.
// The exporter converts view space back into PDF user space.

export type Rotation = 0 | 90 | 180 | 270;

export interface SourceDoc {
  id: string;
  name: string;
  path?: string;
  bytes: Uint8Array; // original file bytes, never modified
}

export interface PageRef {
  id: string;
  docId: string;
  srcIndex: number; // 0-based page index inside the source document
  baseRotation: Rotation; // /Rotate stored in the file
  userRotation: Rotation; // rotation added in this app
  width: number; // unrotated crop box size in points
  height: number;
  blank?: boolean; // inserted blank page (no source page)
}

export type FontFamily = 'cairo' | 'amiri';
export type TextAlign = 'auto' | 'left' | 'center' | 'right';

interface Base {
  id: string;
}

export interface TextOverlay extends Base {
  type: 'text';
  x: number;
  y: number;
  w: number;
  text: string;
  fontSize: number;
  color: string;
  font: FontFamily;
  bold: boolean;
  align: TextAlign;
  // When editing existing PDF text we paint a cover box over the old text first.
  cover?: { x: number; y: number; w: number; h: number; color: string };
}

export interface ImageOverlay extends Base {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string; // always PNG or JPEG
  signature?: boolean;
}

export interface ShapeOverlay extends Base {
  type: 'rect' | 'ellipse' | 'highlight' | 'whiteout';
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
}

export interface LineOverlay extends Base {
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export interface InkOverlay extends Base {
  type: 'ink';
  strokes: [number, number][][];
  stroke: string;
  strokeWidth: number;
}

export interface NoteOverlay extends Base {
  type: 'note';
  x: number;
  y: number;
  text: string;
}

export type Overlay = TextOverlay | ImageOverlay | ShapeOverlay | LineOverlay | InkOverlay | NoteOverlay;

export type FormValue = string | boolean;

export interface DocState {
  pages: PageRef[];
  overlays: Record<string, Overlay[]>; // pageId -> overlays
  formValues: Record<string, FormValue>; // `${pageId}|${fieldName}|${annotId}` -> value
}

export type Tool =
  | 'select'
  | 'text'
  | 'edittext'
  | 'signature'
  | 'image'
  | 'highlight'
  | 'ink'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'whiteout'
  | 'note';

export interface FormField {
  key: string; // formValues key
  annotId: string;
  fieldName: string;
  kind: 'text' | 'checkbox' | 'radio' | 'choice';
  rect: { x: number; y: number; w: number; h: number }; // view space
  multiline?: boolean;
  options?: string[];
  exportValue?: string; // for checkbox/radio: value meaning "on"
  initial: FormValue;
  readOnly?: boolean;
}
