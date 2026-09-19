# Hand-checked card crops

Card crops cut out of three preset screenshots by `recognition/vision.py`, kept only for
the cards where OCR left several candidates tied. `build-01`, `build-02` and `build-03`
are the three screenshots; the number is the card index inside that run, so the names
stay stable if more cards are added later.

The answer for each crop is in `../icon_ground_truth.json` and was read off these images
by eye, not produced by the matcher. Five crops have no answer because the card shows the
part with its own children fitted, which no bare reference can be placed against.

The source screenshots are not checked in. If you regenerate a crop, re-check its answer.
