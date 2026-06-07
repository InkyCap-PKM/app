#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Exemples de mise en forme",
  description: "Une référence rapide et illustrée par l'exemple pour la mise en forme dans InkyCap : chaque élément courant montré sous la forme du balisage que vous tapez, à côté du résultat obtenu — styles de texte, titres, listes, citations, callouts, filets, mathématiques, tableaux, images, vers, symboles, liens, et les éléments InkyCap (tâches, dates, annotations, suggestions).",
  tags: ("documentation",),
  aliases: ("Aide-mémoire", "Syntaxe"),
)

// ── Aides réservées à la documentation ─────────────────────────────────────
// Ces fonctions construisent les encadrés « Vous tapez → Vous obtenez »
// utilisés sur cette page. Elles sont locales à cette note (et ne font pas
// partie du package inkycap-notebox) : la boîte de notes d'un lecteur n'a
// jamais besoin d'une aide à la rédaction de documentation. Chaque exemple est
// écrit une fois à gauche (dans un bloc de code, montré tel quel) et une fois à
// droite (rendu en direct), de sorte que la page est elle-même un exemple
// fonctionnel de tout ce qu'elle décrit.

// `demo` — un tableau à deux colonnes pour les exemples compacts, en ligne.
// Passez des cellules (code, résultat) en alternance.
#let demo(..cells) = block(width: 100%, table(
  columns: (1fr, 1fr),
  inset: 9pt,
  stroke: 0.5pt + luma(85%),
  align: (left + horizon, left + horizon),
  table.header(
    text(0.8em, fill: luma(45%), weight: "bold")[Vous tapez],
    text(0.8em, fill: luma(45%), weight: "bold")[Vous obtenez],
  ),
  ..cells.pos(),
))

// `demo-block` — le code au-dessus, le résultat rendu en dessous, sur toute la
// largeur. Pour les éléments trop larges pour une colonne (callouts, vers,
// tableaux, images, mathématiques d'affichage, filets horizontaux).
#let demo-block(code, result) = block(width: 100%, breakable: false, {
  code
  block(
    width: 100%,
    inset: (left: 12pt, top: 6pt, bottom: 6pt),
    stroke: (left: 2pt + luma(80%)),
    result,
  )
  v(0.4em)
})

= Exemples de mise en forme

#highlight[Pour bien voir ces exemples, consultez cette page en *mode lecture (SVG)*.]

Chaque élément ci-dessous montre le balisage que vous *tapez* à gauche et le résultat que vous *obtenez* à droite. 

#callout("important")[
  InkyCap utilise la syntaxe propre à #link("https://typst.app/docs/reference/syntax/")[Typst], *pas* le Markdown. Taper `**bold**` affiche les caractères littéraux `**bold**`, et `# heading` affiche un `#` littéral. Les marques que vous utilisez réellement sont ci-dessous. Appuyez sur `F1` dans InkyCap pour obtenir un aide-mémoire compact à tout moment.
]

#callout("tip")[
  Vous avez rarement à taper tout ceci à la main. Tapez `/` pour le menu d'insertion, ou sélectionnez du texte pour faire apparaître la barre d'outils de mise en forme. La syntaxe est ici pour que vous puissiez la reconnaître, la taper rapidement quand vous le préférez, et lire votre propre source.
]

== Styles de texte

Les marques fréquemment utilisés. Tapez la marque, votre texte, puis la marque de nouveau. Typst exige un espace ou un signe de ponctuation après le point de fermeture, il ne peut donc pas apparaître au milieu d'un mot. 

#demo(
  [```typ
Ceci est du texte en *gras*.
```],
  [Ceci est du texte en *gras*.],
  [```typ
Ceci est du texte en _italique_.
```],
  [Ceci est du texte en _italique_.],
  [```typ
Un mot #strike[barré].
```],
  [Un mot #strike[barré].],
  [```typ
Un mot #highlight[surligné].
```],
  [Un mot #highlight[surligné].],
  [```typ
Un mot #underline[souligné].
```],
  [Un mot #underline[souligné].],
  [```typ
Un mot #overline[surligné en haut].
```],
  [Un mot #overline[surligné en haut].],
  [```typ
H#sub[2]O et E = mc#super[2].
```],
  [H#sub[2]O et E = mc#super[2].],
  [```typ
Un peu de `code en ligne` ici.
```],
  [Un peu de `code en ligne` ici.],
  [```typ
L'identité $e^(i pi) + 1 = 0$ d'Euler.
```],
  [L'identité $e^(i pi) + 1 = 0$ d'Euler.],
)

#callout("tip")[
  La plupart de ces effets s'activent au clavier : *Ctrl/Cmd+B* (gras), *Ctrl/Cmd+I* (italique). Sélectionnez du texte et appuyez de nouveau sur le même raccourci pour retirer la marque. Le barré, le surlignage, le souligné, le surlignage supérieur, l'indice et l'exposant sont à un clic sur la barre d'outils de sélection.
]

== Titres

Commencez une ligne par un à six signes `=` et une espace. L'espace finale compte — `=Titre` sans elle reste du texte littéral.

#demo-block(
  [```typ
= Titre de niveau 1
== Titre de niveau 2
=== Titre de niveau 3
==== Titre de niveau 4
```],
  [
    #text(1.5em, weight: "bold")[Titre de niveau 1] \
    #text(1.3em, weight: "bold")[Titre de niveau 2] \
    #text(1.15em, weight: "bold")[Titre de niveau 3] \
    #text(1.05em, weight: "bold")[Titre de niveau 4]
  ],
)

En mode visuel, *Ctrl+Maj+Haut / Bas* hausse ou abaisse le niveau du titre courant sans retaper les signes.

== Listes

Commencez chaque ligne par un marqueur et une espace. Appuyez sur *Entrée* pour commencer l'élément suivant, sur *Entrée* dans un élément vide pour terminer la liste, et sur *Tab* / *Maj+Tab* pour augmenter ou diminuer le retrait.

#demo(
  [```typ
- Premier point
- Deuxième point
  - Un point imbriqué
```],
  [
    - Premier point
    - Deuxième point
      - Un point imbriqué
  ],
  [```typ
+ Étape un
+ Étape deux
+ Étape trois
```],
  [
    + Étape un
    + Étape deux
    + Étape trois
  ],
  [```typ
1. Numéro fixe
7. Reste à sept
```],
  [
    1. Numéro fixe
    7. Reste à sept
  ],
  [```typ
/ Typst : un système de composition
/ Boîte de notes : votre ensemble de notes
```],
  [
    / Typst : un système de composition
    / Boîte de notes : votre ensemble de notes
  ],
)

#callout("note")[
  Les listes numérotées avec `+` sont renumérotées pour vous, de sorte que vous pouvez réordonner les éléments librement (*Maj+Alt+Haut / Bas* déplace un élément et garde la numérotation soignée). N'utilisez la forme `1.` que lorsque le numéro doit rester fixe.
]

== Citations

Une citation en ligne se place dans votre phrase ; une citation en bloc met un passage entier à part. Tapez `> ` au début d'une ligne pour une citation en bloc.

#demo-block(
  [```typ
Comme le rappelle #quote[essence n'enveloppe pas l'existence], prenons une grande inspiration.
```],
  [Comme le rappelle #quote[essence n'enveloppe pas l'existence], prenons une grande inspiration.],
)

#demo-block(
  [```typ
#quote(block: true, attribution: [Benedictus de Spinoza, Éthique, traduction par Émile Saisset])[
  Quand une chose peut être conçue comme n'existant pas, son essence n'enveloppe pas l'existence.
]
```],
  [#quote(block: true, attribution: [Benedictus de Spinoza, Éthique, traduction par Émile Saisset])[
      Quand une chose peut être conçue comme n'existant pas, son essence n'enveloppe pas l'existence.
    ]],
)

== Callouts

Les callouts sont les boîtes teintées et encadrées utilisées partout dans ce manuel — idéales pour les astuces, les avertissements et les exemples travaillés. Insérez-en un depuis le menu `/` (*Callout*) ou la barre d'outils, puis choisissez le type en faisant un clic droit sur sa pastille. La forme littérale est `#callout("type")[ ... ]`, avec un `title:` optionnel.

#demo-block(
  [```typ
#callout("warning")[Enregistrez votre travail avant l'exportation.]
```],
  [#callout("warning")[Enregistrez votre travail avant l'exportation.]],
)

#demo-block(
  [```typ
#callout("tip", title: "Un titre à vous")[
  Vous pouvez renommer n'importe quel callout.
]
```],
  [#callout("tip", title: "Un titre à vous")[
      Vous pouvez renommer n'importe quel callout.
    ]],
)

InkyCap propose quinze types, chacun avec sa propre couleur et son titre par défaut :

#demo-block(
  [```typ
#callout("note")[ ... ]      #callout("info")[ ... ]
#callout("tip")[ ... ]       #callout("success")[ ... ]
#callout("question")[ ... ]  #callout("example")[ ... ]
```],
  [
    #grid(
      columns: (1fr, 1fr),
      column-gutter: 8pt,
      row-gutter: 6pt,
      callout("note")[Note], callout("info")[Information],
      callout("tip")[Astuce], callout("success")[Succès],
      callout("question")[Question], callout("example")[Exemple],
    )
  ],
)

L'ensemble complet : *note*, *tip*, *info*, *abstract*, *quote*, *warning*, *caution*, *important*, *danger*, *failure*, *bug*, *example*, *question*, *todo*, *success*.

== Filets horizontaux et sauts

Un filet horizontal trace un séparateur sur toute la largeur entre les sections. Tapez `+++` ou choisissez *Horizontal Rule* dans le menu `/`.

#demo-block(
  [```typ
Texte au-dessus du séparateur.

#line(length: 100%)

Texte en dessous du séparateur.
```],
  [
    Texte au-dessus du séparateur.
    #line(length: 100%)
    Texte en dessous du séparateur.
  ],
)

Pour les autres sauts :

- `#linebreak()` force une nouvelle ligne sans commencer un nouveau paragraphe (ou appuyez simplement sur *Maj+Entrée*).
- `#pagebreak()` commence une nouvelle page — visible en mode lecture, en PDF et dans les exportations de livre.

== Mathématiques

Encadrez une expression avec des signes de dollar. Sans espaces à l'intérieur, elle se place *en ligne* dans votre phrase ; ajoutez une espace juste à l'intérieur de chaque `$` et elle devient un bloc *d'affichage* centré sur sa propre ligne. Les mathématiques se composent en mode lecture et dans les exportations.

#demo(
  [```typ
La somme $a^2 + b^2 = c^2$ est célèbre.
```],
  [La somme $a^2 + b^2 = c^2$ est célèbre.],
)

#demo-block(
  [```typ
$ sum_(k=1)^n k = (n (n + 1)) / 2 $
```],
  [$ sum_(k=1)^n k = (n (n + 1)) / 2 $],
)

== Tableaux

Choisissez *Table* dans le menu `/` pour déposer une grille de départ ; dans l'éditeur visuel, elle devient un tableau interactif (cliquez sur une cellule pour la modifier, glissez un bord pour redimensionner, collez une grille depuis un tableur). Le balisage sous-jacent est `#table(...)` :

#demo-block(
  [```typ
#table(
  columns: (auto, auto, auto),
  [Élément], [Marque], [Résultat],
  [Gras], [`*x*`], [*x*],
  [Italique], [`_x_`], [_x_],
)
```],
  [#table(
      columns: (auto, auto, auto),
      [Élément], [Marque], [Résultat],
      [Gras], [`*x*`], [*x*],
      [Italique], [`_x_`], [_x_],
    )],
)

== Images et médias

Ajoutez une image depuis le menu `/` (*Image*), ou faites simplement glisser un fichier ou collez-en un — InkyCap le copie dans le dossier de pièces jointes de votre boîte de notes pour que l'image voyage avec vos notes. Réglez la largeur, le texte de remplacement et l'alignement depuis son menu de pastille.

#demo-block(
  [```typ
#image("/Assets/inkycap-logo.svg", width: 20%, alt: "Otto, la mascotte d'InkyCap")
```],
  [#align(center, image("/Assets/inkycap-logo.svg", width: 20%, alt: "Otto, la mascotte d'InkyCap"))],
)

La vidéo et l'audio fonctionnent de la même façon — `#video("/Assets/clip.mp4")` et `#audio("/Assets/prise.mp3")`. Ils se lisent en direct dans l'éditeur et deviennent de véritables lecteurs quand vous publiez vers le web ; dans un PDF, ils apparaissent comme un substitut soigné nommant le fichier. Voir #wikilink("3 - Exportation et publication").

== Vers

Pour la poésie, les paroles, ou tout texte où l'espacement et le retrait exacts doivent survivre, utilisez les *vers*. Contrairement aux paragraphes ordinaires (où les espaces supplémentaires se condensent), les vers préservent chaque espace que vous tapez et contrairement au bloc de code préformaté vers lequel se rabattent d'autres outils, ils gardent votre police habituelle et laissent la mise en forme en ligne fonctionner ligne par ligne. 

_Notez que notre exemple présente le balisage dans une police à chasse fixe, puis bascule vers une police proportionnelle (à chasse variable) lors du rendu, ce qui modifie l'espacement apparent. L'objectif est de montrer qu'il est possible de conserver un espacement personnalisé tout en choisissant sa propre police._

#demo-block(
  [```typ
#verse("RIEN


       de la mémorable crise
               ou se fût
                   l'évènement          accompli en vue de tout résultat nul
                                                                              humain

                                                              N'AURA EU LIEU
                                                           une élévation ordinaire verse l'absence

                                                                                         QUE LE LIEU
                                                   inférieur clapotis quelconque comme pour disperser l'acte vide")
```],
  [#verse("
  
  RIEN


       de la mémorable crise
               ou se fût
                   l'évènement          accompli en vue de tout résultat nul
                                                                              humain

                                                              N'AURA EU LIEU
                                                           une élévation ordinaire verse l'absence

                                                                                         QUE LE LIEU
                                                   inférieur clapotis quelconque comme pour disperser l'acte vide
                                                   ")],
)

#align(right)[(_Stéphane Mallarmé, Un coup de dés jamais n'abolira le hasard, 1914_)] 

Les vers acceptent des options d'alignement, de numérotation des lignes (`numbered: true`) et d'espacement des lettres, et vous pouvez définir une police de vers par défaut pour toute la boîte de notes. Voir #wikilink("3 - Mettre en forme votre texte") pour en savoir plus.

== Symboles et ponctuation intelligente

InkyCap transforme ces raccourcis en véritables caractères typographiques à mesure que vous tapez. L'ensemble complet se trouve sous *Symbol* dans le menu `/`.

#demo(
  [```typ
Un tiret cadratin --- comme ceci.
```],
  [Un tiret cadratin --- comme ceci.],
  [```typ
Pages 10--20 avec un tiret demi-cadratin.
```],
  [Pages 10--20 avec un tiret demi-cadratin.],
  [```typ
Et ainsi de suite...
```],
  [Et ainsi de suite...],
  [```typ
10~kg reste sur une seule ligne.
```],
  [10~kg reste sur une seule ligne.],
)

Une espace insécable (`~`) garde deux mots ensemble pour qu'ils ne se séparent jamais en bout de ligne. Un trait d'union conditionnel (`-?`) marque un endroit invisible où un long mot *peut* se couper.

== Liens

Les liens externes utilisent `#link` ; les liens vers d'autres notes de votre boîte de notes utilisent `#wikilink` (ou tapez simplement `[[`). Les liens wiki sont au cœur de la façon dont InkyCap relie les notes — voir #wikilink("4 - Liens et rétroliens").

#demo(
  [```typ
Visitez #link("https://typst.app")[le site de Typst].
```],
  [Visitez #link("https://typst.app")[le site de Typst].],
  [```typ
Voir la page #wikilink("2 - Modifier des notes").
```],
  [Voir la page #wikilink("2 - Modifier des notes").],
  [```typ
#wikilink("2 - Modifier des notes", display: "modifier")
```],
  [#wikilink("2 - Modifier des notes", display: "modifier")],
)

== Notes de bas de page

Une note de bas de page dépose un petit appel dans votre texte et rassemble la note au bas de la page (ou à la fin du document, selon la sortie). Tapez `++…++`, choisissez *Footnote* dans le menu `/`, ou écrivez-la directement :

```typ
Le résultat était concluant.#footnote[Otlet et coll., 2024, p. 42.]
```

== Éléments InkyCap

Voici les éléments propres à InkyCap — les pièces interrogeables qui alimentent l'Agenda, les panneaux et la collaboration. Chacun est documenté en profondeur sur sa propre page ; voici le balisage en un coup d'œil.

Les *tâches* sont des cases à cocher en ligne qui se rassemblent aussi dans l'Agenda. Tapez `- [ ]` ou utilisez *Task* dans le menu `/` :

#demo(
  [```typ
#task("Lire les épreuves")
```],
  [#box[☐ Lire les épreuves]],
  [```typ
#task("Écrire à la rédactrice", due: datetime(year: 2026, month: 6, day: 30))
```],
  [#box[☐ Écrire à la rédactrice] #box(fill: rgb("#eef2ff"), inset: (x: 4pt, y: 1pt), radius: 2pt, text(0.85em)[2026-06-30])],
)

Les *dates* attachent un rappel à votre prose et apparaissent dans l'Agenda — `#due(datetime(year: 2026, month: 6, day: 30), label: "Échéance de la subvention")`. Voir #wikilink("3 - Agenda, tâches et dates").

Les *annotations* sont des commentaires en marge qui restent visibles en mode lecture sans devenir du texte de corps :

```typ
#annotation([Revérifier ce chiffre avant la soumission.], by: "JC", on: datetime(year: 2026, month: 6, day: 7))
```

Les *modifications suggérées* sont des marques de suivi des modifications — la primitive du « mode suggestion ». Dans l'éditeur visuel, elles montrent le visage familier insertion-verte / suppression-rouge ; un document compilé montre la modification comme si elle était acceptée. Voir #wikilink("1 - Collaboration").

```typ
Cette ébauche est #suggestion([claire et], kind: "insert") bien argumentée.
```

== Pour les utilisateurs de Typst

#callout("tip", title: "Pour les utilisateurs de Typst")[
  Rien ici n'est une boîte fermée. Tout est du balisage Typst pur, vous pouvez donc toujours basculer en Typst brut pour tout ce que les menus ne font pas surgir : règles set, règles show, fonctions personnalisées, packages. Un appel de fonction que vous écrivez apparaît derrière une petite pastille `#` cerclée dans l'éditeur visuel — cliquez dessus pour modifier la source en ligne, ou basculez en mode source pour voir directement le Typst complet. Les encadrés à deux colonnes de *cette* page sont construits avec un `#table` Typst ordinaire et une petite aide locale, rien de plus.
]

== Pages connexes

- #wikilink("3 - Mettre en forme votre texte"). La présentation racontée des mêmes fonctionnalités, le menu barre oblique et la barre d'outils de sélection
- #wikilink("3.2 - Mise en forme avancée"). Le menu Style — les règles set de page, de police et d'espacement qui apparaissent dans les exportations et la vue de lecture
- #wikilink("2 - Modifier des notes"). Les modes d'édition et les bases du travail dans une note
- #wikilink("4 - Liens et rétroliens"). Relier les notes avec des liens wiki
- #wikilink("3 - Agenda, tâches et dates"). Comment les tâches et les dates se rassemblent dans votre boîte de notes
- #wikilink("3 - Exportation et publication"). Transformer vos notes mises en forme en PDF, en livres et en pages web
