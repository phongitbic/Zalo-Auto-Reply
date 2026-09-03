const normalize = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const parsePriorityLocations = (content = "") =>
  String(content)
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map(normalize)
    .filter(Boolean);

export const matchesPriorityLocation = (messageText, locations) => {
  const normalizedMessage = ` ${normalize(messageText)} `;
  return locations.some((location) => normalizedMessage.includes(` ${location} `));
};
