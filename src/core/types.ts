export type LayerKey = 'Text' | 'Image' | 'Rectangle' | 'Ellipse';
export interface TextData {
  Text: string;
  FontFamilyName: string;
  FontWeight: string;
  FontSize: number;
  FontStyle: string;
  TextAlignment: number;
  LineHeight: number;
  TextSpaceNumber: number;
  Color: string;
  TextBoxMode: boolean;
  Width: number;
  Height: number;
  StrokeEnable: boolean;
  StrokePosition: number;
  StrokeThickness: number;
  StrokeColor: string;
  ShadowEnable: boolean;
  ShadowDepth: number;
  ShadowDirection: number;
  ShadowColor: string;
  ShadowOpacity: number;
  ShadowBlurRadius: number;
  VariableEnable: boolean;
  VariableTemplate: string;
}
export interface ImageData {
  Opacity: number;
  ImageUrl: string;
  VariableEnable: boolean;
  VariableImageUrl: string;
  EmbedImage: boolean;
  Image: string;
  Width: number;
  Height: number;
}
export interface ShapeData {
  FillColor: string;
  BorderColor: string;
  BorderWidth: number;
  Width: number;
  Height: number;
  RadiusLink: boolean;
  RadiusTopLeft: number;
  RadiusTopRight: number;
  RadiusBottomRight: number;
  RadiusBottomLeft: number;
}
export interface LayerModel {
  Id: string;
  Key: LayerKey;
  ZIndex: number;
  Left: number;
  Top: number;
  Visible: boolean;
  PageBackground: boolean;
  LayerNameCustom: string;
  ClippingMaskEnable: boolean;
  ClippingMaskBottom: boolean;
  Data: TextData | ImageData | ShapeData;
}
export interface FormatCondition {
  Name: string;
  Condition: string;
  LayersVisable: Record<string, boolean>;
}
export interface ConditionGroup {
  Name: string;
  Color: string;
  EffctiveLayers: string[];
  FormatConditionModels: FormatCondition[];
}
export interface TedDocument {
  VersionCode: number;
  DocModel: {
    Width: number;
    Height: number;
    CreatedAt: string;
    UpdatedAt: string;
    FormatConditionGroups: ConditionGroup[];
  };
  Layers: LayerModel[];
}
export type DataRow = Record<string, string>;
export interface TableData {
  headers: string[];
  rows: DataRow[];
}
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type ImageResolver = (
  source: string,
  embedded?: string,
) => Promise<CanvasImageSource | null>;
export interface RenderResult {
  bounds: Record<string, Bounds>;
  warnings: string[];
}
