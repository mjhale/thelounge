export type InputHeightChange = {
	height: number;
	changed: boolean;
};

export function getInputHeightChange(
	currentHeight: number,
	scrollHeight: number,
	lineHeight: number
): InputHeightChange {
	const safeLineHeight = lineHeight > 0 ? lineHeight : 1;
	const height = Math.ceil(scrollHeight / safeLineHeight) * safeLineHeight;

	return {
		height,
		changed: height !== currentHeight,
	};
}
