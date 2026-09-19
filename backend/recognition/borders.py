"""Fit card boxes to four visible borders instead of assuming text is the top-left corner."""


class CardBorderFitter:
    def __init__(self, image):
        import cv2
        import numpy as np

        self.height, self.width = image.shape[:2]
        self.scale = self.height / 1080
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.int16)
        # Count sustained axis-aligned contrast instead of favouring bright gun texture.
        vertical = (np.abs(np.diff(gray, axis=1, prepend=gray[:, :1])) >= 7).astype(np.uint8)
        horizontal = (np.abs(np.diff(gray, axis=0, prepend=gray[:1, :])) >= 7).astype(np.uint8)
        self.vertical = np.pad(np.cumsum(vertical, axis=0), ((1, 0), (0, 0)))
        self.horizontal = np.pad(np.cumsum(horizontal, axis=1), ((0, 0), (1, 0)))

    def fit(self, box):
        import numpy as np

        original_x, original_y, _, _ = box
        radius = round(34 * self.scale)
        sides = range(max(12, round(63 * self.scale)), max(13, round(68 * self.scale)) + 1)
        best = None
        for side in sides:
            xs = np.arange(max(1, original_x - radius), min(self.width - side - 1, original_x + radius) + 1)
            ys = np.arange(max(1, original_y - radius), min(self.height - side - 1, original_y + radius) + 1)
            if not xs.size or not ys.size:
                continue
            x, y = np.meshgrid(xs, ys)
            # Exclude corners so category icons and connectors do not dominate border support.
            inset = max(2, round(3 * self.scale))
            length = side - 2 * inset
            left = (self.vertical[y + side - inset, x] - self.vertical[y + inset, x]) / length
            right = (self.vertical[y + side - inset, x + side] - self.vertical[y + inset, x + side]) / length
            top = (self.horizontal[y, x + side - inset] - self.horizontal[y, x + inset]) / length
            bottom = (self.horizontal[y + side, x + side - inset] - self.horizontal[y + side, x + inset]) / length
            support = np.stack([left, right, top, bottom])
            score = support.mean(axis=0) * 0.5 + support.min(axis=0) * 0.5
            distance = (abs(x - original_x) + abs(y - original_y)) / self.scale
            objective = score - distance * 0.001
            iy, ix = np.unravel_index(objective.argmax(), objective.shape)
            candidate = (
                float(objective[iy, ix]),
                float(score[iy, ix]),
                [int(x[iy, ix]) - 1, int(y[iy, ix]) - 1, side + 2, side + 2],
            )
            if best is None or candidate[0] > best[0]:
                best = candidate
        if best is None or best[1] < 0.55:
            return None
        return {"box": best[2], "border_support": round(best[1], 4)}
