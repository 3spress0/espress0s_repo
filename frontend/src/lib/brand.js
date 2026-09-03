/**
 * The application mark.
 *
 * One constant, imported everywhere a logo is drawn, so the icon can be
 * replaced by dropping a new file in frontend/public and editing this line -
 * rather than hunting down every <img src="..."> in the tree, which is how the
 * favicon, the navbar and the footer drifted apart before.
 *
 * /apple-touch-icon.png is the 180x180 isometric stack. Its corners are
 * transparent, so it sits correctly on both the dark and light themes, and it
 * is raster: unlike the old inline SVG it renders identically in every browser
 * and at every size the UI asks for.
 */
export const LOGO_SRC = '/apple-touch-icon.png';

/** Alt text for the one place the mark is meaningful rather than decorative. */
export const LOGO_ALT = "espress0's repo";
