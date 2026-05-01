"use client";

import type { CanvasEl, ToolId } from "../../lib/canvas-types";
import type { Dispatch } from "./types";
import { ShapeContainer, type ShapeContainerExtraProps } from "./ShapeContainer";
import { TextContainer, type TextContainerExtraProps } from "./TextContainer";
import { ImageContainer, type ImageContainerExtraProps } from "./ImageContainer";
import { ChartContainer } from "./ChartContainer";
import { MathContainer, type MathContainerExtraProps } from "./MathContainer";
import { NoteRefContainer } from "./NoteRefContainer";

/**
 * Shell-facing dispatcher: picks the right container for `el.type`.
 *
 * Returns null for element types that haven't been extracted yet — during the
 * Stage 3 migration, the shell continues rendering those types inline and this
 * switch grows one case at a time. Post-migration, the shell's render tree is
 * just `{visibleElements.map(el => <CanvasElement ... />)}`.
 */
export type CanvasElementProps = {
  el: CanvasEl;
  canvasScale: number;
  activeTool: ToolId | null;
  locked: boolean;
  selected: boolean;
  dispatch: Dispatch;
  onMeasure?: (id: string, w: number, h: number) => void;
  /** Per-type extension props. Each container takes what it needs, ignores the rest. */
  shapeExtras?: ShapeContainerExtraProps;
  textExtras?: TextContainerExtraProps;
  imageExtras?: ImageContainerExtraProps;
  mathExtras?: MathContainerExtraProps;
};

export function CanvasElement(props: CanvasElementProps) {
  const { el, shapeExtras, textExtras, imageExtras, mathExtras, ...base } = props;

  switch (el.type) {
    case "shape":
      return <ShapeContainer el={el} {...base} {...(shapeExtras ?? ({} as ShapeContainerExtraProps))} />;
    case "text":
      return <TextContainer el={el} {...base} {...(textExtras ?? ({} as TextContainerExtraProps))} />;
    case "image":
      return <ImageContainer el={el} {...base} {...(imageExtras ?? ({} as ImageContainerExtraProps))} />;
    case "chart":
      return <ChartContainer el={el} {...base} />;
    case "math":
      return <MathContainer el={el} {...base} {...(mathExtras ?? ({} as MathContainerExtraProps))} />;
    case "noteRef":
      return <NoteRefContainer el={el} {...base} />;
    default:
      return null;
  }
}
