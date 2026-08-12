import {getInputHeightChange} from "../../../../client/js/helpers/inputHeight";

describe("getInputHeightChange", () => {
	it("does not report a resize for ordinary same-line typing", () => {
		expect(getInputHeightChange(24, 23, 24)).toEqual({height: 24, changed: false});
	});

	it("reports a resize when the input gains another line", () => {
		expect(getInputHeightChange(24, 25, 24)).toEqual({height: 48, changed: true});
	});

	it("uses a safe fallback for an unavailable computed line height", () => {
		expect(getInputHeightChange(0, 7, 0)).toEqual({height: 7, changed: true});
	});
});
