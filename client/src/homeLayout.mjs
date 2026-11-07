// Home layout: Overview with Charlie docked beside it.
// wide >= 1350, laptop 1024-1349, stacked < 1024. A non-number or <= 0 width reads as "wide".
export const HOME_WIDE_MIN = 1350;
export const HOME_LAPTOP_MIN = 1024;
export const DOCK_WIDTH = { wide: 408, laptop: 340 };

export const homeLayout = (width) => {
  if (typeof width !== "number" || !(width > 0)) return "wide";
  if (width >= HOME_WIDE_MIN) return "wide";
  if (width >= HOME_LAPTOP_MIN) return "laptop";
  return "stacked";
};
