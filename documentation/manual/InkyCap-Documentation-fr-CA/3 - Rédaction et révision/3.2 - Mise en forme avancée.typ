#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Mise en forme avancée",
  description: "La catégorie Style du menu barre oblique — taille de page, marges, numérotation, colonnes, polices, taille et langue du texte, justification et espacement. Comment ces règles set à l'échelle du document n'apparaissent qu'en mode lecture et dans les exportations, pourquoi l'éditeur visuel les présente sous forme de pastille, et comment les modifier là ou en mode source.",
  tags: ("documentation",),
)

= Mise en forme avancée

La page #wikilink("3 - Mettre en forme votre texte") couvre les marques qui mettent en forme _des mots et des blocs particuliers_ — gras, titres, listes, callouts, et ainsi de suite. Cette page couvre l'autre moitié : la catégorie *Style* du menu « / », qui règle l'apparence du _document entier_ — sa page, son texte courant et ses paragraphes.

#callout("note")[
  Tout dans le menu Style est une *règle set* Typst : une instruction d'une ligne comme `#set text(size: 12pt)` qui change une valeur par défaut à partir de cet endroit. Elle met en forme le document ; elle n'insère rien que vous lisez.
]

== La première chose à comprendre

Une règle set change la façon dont votre note est *composée* — son effet apparaît donc dans la *Vue de lecture* et dans vos *exportations* (PDF, livre, page web), là où le document est réellement mis en page en pages et en paragraphes. Elle ne change *pas* l'apparence de l'éditeur source ni de l'éditeur visuel, où vous travaillez avec le balisage lui-même.

C'est voulu, et non une limite : l'éditeur visuel est une surface d'écriture, pas un aperçu de page. Lui demander de repaginer, de changer la police du corps de texte ou de remettre votre texte en colonnes à chaque frappe nuirait à l'écriture. Alors plutôt que de ne rien faire de visible en silence, une règle set que vous déposez dans une note apparaît dans l'éditeur visuel sous la forme d'une petite *pastille* — un repère que vous pouvez voir, cliquer et modifier — et fait son véritable travail au moment où la note est rendue.

#callout("tip")[
  Pour vérifier l'effet d'un réglage Style, basculez vers la *Vue de lecture* (ou exportez). C'est là que la taille de page, les marges, les colonnes, les polices et l'espacement deviennent visibles.
]

== Le menu Style en un coup d'œil

Tapez « / », choisissez *Style* (ou commencez à taper le nom), puis sélectionnez un réglage. InkyCap insère la règle set avec une valeur de départ raisonnable et place votre curseur sur la partie que vous voudrez modifier. La liste complète :

#table(
  columns: (auto, 1fr),
  inset: 8pt,
  stroke: 0.5pt + luma(85%),
  table.header([*Élément du menu*], [*Ce qu'il insère*]),
  [Page size], [`#set page(paper: "a4")`],
  [Page margins], [`#set page(margin: (top: 2cm, bottom: 2cm, left: 2cm, right: 2cm))`],
  [Page numbering], [`#set page(numbering: "1")`],
  [Page columns], [`#set page(columns: 2)`],
  [Text font], [`#set text(font: "")`],
  [Text size], [`#set text(size: 12pt)`],
  [Text language], [`#set text(lang: "en")`],
  [Justify], [`#set par(justify: true)`],
  [Line spacing], [`#set par(leading: 0.65em)`],
  [Paragraph spacing], [`#set par(spacing: 1.2em)`],
  [First line indent], [`#set par(first-line-indent: 1em)`],
  [Heading numbering], [`#set heading(numbering: "1.1")`],
)

Quelques précisions sur les valeurs :

- *Page size* (taille de page) prend un nom de papier comme `"a4"`, `"us-letter"` ou `"a5"`.
- *Page numbering* (numérotation des pages) et *Heading numbering* (numérotation des titres) prennent une chaîne de motif : `"1"` pour des chiffres simples, `"i"` pour des chiffres romains, `"1.1"` pour des titres imbriqués `1`, `1.1`, `1.1.1`, et ainsi de suite.
- *Text font* (police du texte) commence vide — tapez un nom de police entre les guillemets (les mêmes noms que vous trouverez dans #wikilink("2 - Paramètres")). Laissez-la vide et rien ne change.
- Les longueurs utilisent les unités de Typst : `pt`, `cm`, `mm`, `in` ou `em` (un multiple de la taille de police courante). L'interligne `0.65em` est relatif à la taille du texte ; des marges `2cm` sont absolues.

== Où une règle set prend effet

Une règle set s'applique *de l'endroit où elle se trouve jusqu'à la fin de la note*. Placez-la près du *début de la note* (juste sous les propriétés) et elle régit le document entier — ce que vous voulez presque toujours pour la taille de page, la police ou les marges.

En placer une à mi-chemin est parfois utile — par exemple, passer à deux colonnes pour la seconde moitié d'une note — mais si vous voulez simplement que le réglage s'applique partout, gardez-le en haut.

#callout("note")[
  Ces règles vivent dans *une seule note*. Elles ne s'étendent pas à votre boîte de notes. Pour mettre en forme plusieurs notes à la fois — toute une #wikilink("2 - Collections", display: "collection") ou un livre — utilisez les *substitutions de style* de la collection, qui appliquent les mêmes types de réglages à chaque note de la collection au moment de l'exportation. Voir #wikilink("2 - Collections") et #wikilink("3 - Exportation et publication").
]

== Modifier un réglage Style dans l'éditeur visuel

Dans l'éditeur visuel, une règle set apparaît sous la forme d'une pastille étiquetée qui nomme ce qu'elle configure — `set text: font`, `set par: leading`, `set page: margin`, et ainsi de suite — afin que vous puissiez distinguer d'un coup d'œil deux règles `#set text(...)`. Pour la modifier :

- *Cliquez sur la pastille* (ou amenez votre curseur sur sa ligne). La pastille se déploie pour révéler la ligne `#set …` brute, entièrement modifiable sur place. Ajustez la valeur, puis cliquez ou déplacez-vous ailleurs et elle se replie en pastille.
- *Faites un clic droit sur la pastille* pour un menu : *Edit source*, *Open in source editor* et *Copy / Duplicate / Remove style / Delete*. *Delete* retire complètement le réglage — pratique quand vous voulez revenir aux valeurs par défaut d'InkyCap.

#callout("tip")[
  Une série de règles set au tout début d'une note est traitée comme la *configuration* de la note et rangée ensemble au-dessus de votre texte, à l'écart. Une règle set que vous ajoutez plus tard, dans le corps, obtient sa propre pastille là où elle se trouve. Dans les deux cas, le balisage n'est jamais perdu — il est seulement replié par souci de propreté.
]

== La modifier en mode source

En mode source, il n'y a pas de pastille — vous voyez la ligne `#set …` littérale et la modifiez comme n'importe quel autre texte. C'est la façon la plus directe d'ajuster finement les valeurs, de combiner plusieurs réglages en une seule règle ou de faire tout ce que le menu ne fait pas surgir :

```typ
#set page(paper: "a4", margin: 2.5cm, numbering: "1")
#set text(font: "EB Garamond", size: 11pt, lang: "fr")
#set par(justify: true, leading: 0.7em, first-line-indent: 1em)
```

Chaque appel `#set` accepte plusieurs arguments à la fois, de sorte que les trois lignes ci-dessus configurent la page, le texte courant et les paragraphes d'une note entière. Le mode source et l'éditeur visuel sont deux vues du *même* Typst — une modification dans l'un apparaît dans l'autre.

== Pour les utilisateurs de Typst

#callout("tip", title: "Pour les utilisateurs de Typst")[
  Le menu Style n'est qu'une interface conviviale par-dessus les règles `set` de Typst pour les éléments `page`, `text`, `par` et `heading` — rien de propre à InkyCap. Tout ce que vous pouvez écrire dans une règle set fonctionne : `#set heading(numbering: "1.a")`, `#set page(header: …)`, une règle `#show`, vos propres fonctions, un package importé. Elles se rendent dans la Vue de lecture et les exportations et apparaissent sous forme de pastille dans l'éditeur visuel ; basculez en mode source pour voir et modifier directement le Typst complet. Pour la référence complète, voir la #link("https://typst.app/docs/reference/")[documentation de Typst].
]

== Pages connexes

- #wikilink("3 - Mettre en forme votre texte"). Les marques de tous les jours pour mettre en forme mots et blocs
- #wikilink("3.1 - Exemples de mise en forme"). Un aide-mémoire facile à parcourir des marques courantes
- #wikilink("2 - Modifier des notes"). Les modes d'édition, la commande barre oblique et le fonctionnement des pastilles
- #wikilink("2 - Collections"). Les substitutions de style qui appliquent des réglages à de nombreuses notes
- #wikilink("3 - Exportation et publication"). Là où les réglages de page, de police et d'espacement deviennent visibles
