// Phone layout helpers. Below 768px the app switches to a drawer nav and stacked grids; 768px and up is unchanged.
export const PHONE_MAX_WIDTH = 767;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

export const isPhoneWidth = (width) => typeof width === "number" && width > 0 && width <= PHONE_MAX_WIDTH;

// The gridTemplateColumns for an n-column row: on phone 4 -> 2 columns, 3 or 2 -> 1 column.
export const gridCols = (n, isPhone) => {
  const cols = !isPhone ? n : n >= 4 ? 2 : 1;
  return Array(cols).fill("1fr").join(" ");
};
