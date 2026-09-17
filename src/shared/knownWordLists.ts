export const KNOWN_WORD_LISTS = [
  {
    id: "junior-high",
    label: "初中课标词汇",
    file: "assets/known-wordlists/junior-high.txt"
  },
  {
    id: "senior-high",
    label: "高中课标词汇",
    file: "assets/known-wordlists/senior-high.txt"
  },
  {
    id: "cet4",
    label: "四级 4882 词",
    file: "assets/known-wordlists/cet4.txt"
  },
  {
    id: "cet6",
    label: "六级 5953 词",
    file: "assets/known-wordlists/cet6.txt"
  },
  {
    id: "toefl",
    label: "托福 6586 词",
    file: "assets/known-wordlists/toefl.txt"
  },
  {
    id: "gre",
    label: "GRE 10326 词",
    file: "assets/known-wordlists/gre.txt"
  },
  {
    id: "coca-20000",
    label: "COCA 20000 高频词",
    file: "assets/known-wordlists/coca-20000.txt"
  }
] as const;

export type KnownWordListId = typeof KNOWN_WORD_LISTS[number]["id"];
export const KNOWN_WORD_LIST_IDS = KNOWN_WORD_LISTS.map((list) => list.id);
