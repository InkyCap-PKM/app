#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Raccourcis clavier",
  description: "Une référence groupée des raccourcis clavier les plus utiles d'InkyCap, avec des notes sur les touches macOS et le panneau d'Aide intégré à l'application.",
  tags: ("documentation",),
)

= Raccourcis clavier

Cette page est une référence rapide des raccourcis clavier qui vous aident à vous déplacer dans InkyCap, à écrire plus vite, et à afficher ou masquer des panneaux (sans avoir à prendre la souris). Vous n'avez rien à mémoriser de tout cela. InkyCap garde une liste à jour des raccourcis intégrée à l'application.

La poignée de raccourcis dans les sections #wikilink("2 - Modifier des notes") et #wikilink("3 - Mettre en forme votre texte") sont ceux que la plupart des rédacteurs utilisent en premier.

== Un mot pour les utilisateurs Mac

Les raccourcis ci-dessous sont écrits avec *Ctrl* (la touche que les utilisateurs Linux et Windows appuient). Sur macOS, appuyez plutôt sur *⌘ (Commande)* partout où vous voyez _Ctrl_. InkyCap les traite comme la même touche. Le panneau d'Aide intégré affiche pour vous les glyphes Mac (`⌘` pour Ctrl, `⇧` pour Shift, `⌥` pour Alt).

#callout("tip")[
La façon la plus rapide de trouver n'importe quel raccourci est d'appuyer sur *F1* pour ouvrir le panneau d'Aide, puis de taper un mot dans son champ de filtre. Plus de détails ci-dessous.
]

== Obtenir de l'aide dans InkyCap

Appuyez sur *`F1`* (ou cliquez sur le bouton *Info* dans la barre d'outils de l'éditeur) pour ouvrir le panneau d'Aide. Il offre trois vues entre lesquelles vous pouvez basculer :

- *Raccourcis de l'interface*. Chaque raccourci global regroupé par catégorie.
- *Éditeur visuel*. Les touches de mise en forme et les raccourcis de saisie que vous utilisez en écrivant.
- *Balisage Typst*. Un aide-mémoire du balisage Typst, utile en complément de #wikilink("3 - Mettre en forme votre texte").
\

== Navigation

Utilisez-les pour sauter entre les notes, les onglets et les différentes parties de la fenêtre. Les régions de la fenêtre dont il est question ici (les barres latérales, l'éditeur et la barre d'état) sont expliquées dans #wikilink("1 - L'interface InkyCap").
#table(
  columns: (auto, auto),
  table.header([Raccourci], [Action]),
  [`Ctrl+O`], [Chercheur de fichiers Ouverture rapide],
  [`Ctrl+P`], [Palette de commandes],
  [`Ctrl+Tab`], [Onglet suivant],
  [`Ctrl+Shift+Tab`], [Onglet précédent],
  [`Ctrl+1` … `Ctrl+9`], [Passer directement à l'onglet 1 à 9],
  [`Ctrl+Shift+F`], [Rechercher dans la boîte de notes],
  [`F6`], [Cibler la région suivante (barre latérale, éditeur, panneau…)],
  [`Shift+F6`], [Cibler la région précédente],
  [`Ctrl+Shift+0`], [Sauter directement à l'éditeur actif],
  [`Esc`], [Depuis un panneau, ramener le focus à l'éditeur],
)

#callout("tip")[
*F6* parcourt les régions visibles de la fenêtre dans l'ordre, en sautant tout panneau que vous avez replié. C'est la façon, uniquement au clavier, d'atteindre la barre latérale ou un panneau latéral et de l'utiliser entièrement au clavier.
]

Quand un panneau est ciblé, vous pouvez parcourir ses propres onglets internes avec *Ctrl+PageDown* et *Ctrl+PageUp*. (Ceux-ci n'agissent qu'une fois que vous avez ciblé le panneau avec *F6* d'abord.)

À l'intérieur de l'arborescence de fichiers et d'autres listes, les touches fléchées déplacent la sélection, *Entrée* ou *Espace* ouvre ou active l'élément en surbrillance, et *Début* / *Fin* sautent aux extrémités. Dans l'arborescence de fichiers en particulier, *→* déploie un dossier (ou y entre) et *←* le replie (ou en ressort vers le parent).

== Édition

Ceux-ci agissent sur la note que vous écrivez. Voyez #wikilink("2 - Modifier des notes") pour la vue d'ensemble du fonctionnement de l'édition.
#table(
  columns: (auto, auto),
  table.header([Raccourci], [Action]),
  [`Ctrl+N`], [Nouvelle note],
  [`Ctrl+D`], [Note quotidienne (note du jour)],
  [`Ctrl+T`], [Nouvel onglet vide],
  [`Ctrl+W`], [Fermer l'onglet],
  [`Ctrl+Shift+T`], [Rouvrir le dernier onglet fermé],
  [`Ctrl+M`], [Déplacer le fichier vers…],
  [`Ctrl+Shift+D`], [Supprimer le fichier],
  [`F2`], [Renommer le fichier courant],
  [`Ctrl+H`], [Rechercher et remplacer (dans la note courante)],
  [`Ctrl+=` / `Ctrl++`], [Zoomer],
  [`Ctrl+-`], [Dézoomer],
  [`Ctrl+0`], [Réinitialiser le zoom],
)

#callout("note")[
*Ctrl+N* et *Ctrl+D* proviennent des règles de création de notes intégrées d'InkyCap, et contrairement à la plupart des raccourcis, _ces deux-là, vous pouvez les changer vous-même_. Chaque règle de création a un raccourci modifiable. Voyez #wikilink("3 - Scaffolds, Templates et Packages") pour savoir comment fonctionnent les règles de création.
]

=== Touches de mise en forme (en écrivant)

Celles-ci agissent à l'intérieur du contenu d'une note. Ce sont des bascules ; appuyez de nouveau sur la même combinaison pour retirer la mise en forme. Il y a beaucoup plus à ce sujet dans #wikilink("3 - Mettre en forme votre texte").

#table(
  columns: (auto, auto, auto),
  table.header([Raccourci], [Action], [Produit]),
  [`Ctrl+B`], [Gras], [`*…*`],
  [`Ctrl+I`], [Italique], [`_…_`],
  [`Ctrl+E`], [Code en ligne], [`` `…` ``],
  [`Ctrl+Shift+X`], [Barré], [`#strike[…]`],
  [`Ctrl+Shift+H`], [Surlignage], [`#highlight[…]`],
  [`Ctrl+Shift+M`], [Math en ligne], [`$…$`],
  [`Tab`], [Indenter l'élément de liste], [],
  [`Shift+Tab`], [Désindenter l'élément de liste], [],
  [`Shift+Alt+Up`], [Déplacer la ligne / l'élément vers le haut], [],
  [`Shift+Alt+Down`], [Déplacer la ligne / l'élément vers le bas], [],
  [`Ctrl+Shift+Up`], [Diminuer le niveau de titre], [],
  [`Ctrl+Shift+Down`], [Augmenter le niveau de titre], [],
)

#callout("tip")[
Vous pouvez aussi mettre en forme en *tapant* simplement le balisage au fil de l'eau : `*gras*`, `_italique_`, `= ` pour un titre, `- ` pour une puce, et ainsi de suite. Commencez une ligne par `/` pour ouvrir le menu de commandes de l'éditeur. Ces raccourcis tapés sont énumérés dans la vue *Éditeur visuel* du panneau d'Aide, et expliqués dans #wikilink("3 - Mettre en forme votre texte").
]

== Panneaux et vues

Affichez, masquez et basculez entre les panneaux et les modes d'édition d'InkyCap.

#table(
  columns: (auto, auto),
  table.header([Raccourci], [Action]),
  [`Ctrl+/`], [Afficher/masquer la barre latérale gauche],
  [`Ctrl+\`], [Afficher/masquer le panneau de droite],
  [`Ctrl+,`], [Ouvrir les Paramètres],
  [`Ctrl+Shift+N`], [Nouvelle fenêtre],
  [`Ctrl+Shift+L`], [Basculer le thème foncé / clair],
  [`Ctrl+Shift+M`], [Basculer le mode Source / Aperçu en direct],
  [`Ctrl+Shift+R`], [Basculer le Mode lecture],
  [`Ctrl+Shift+1`], [Basculer le mode Sans distraction],
  [`Ctrl+Shift+]`], [Diviser l'éditeur vers la droite],
  [`Ctrl+Shift+[`], [Diviser l'éditeur vers le bas],
  [`Ctrl+Shift+W`], [Fermer le panneau d'éditeur courant],
  [`Ctrl+Shift+Y`], [Ouvrir la Vue mycélienne],
  [`Ctrl+Shift+J`], [Basculer le Rouleau de journal],
)

Les modes d'édition et les vues ci-dessus ont leurs propres pages : #wikilink("1 - Vues et navigation"), #wikilink("5 - Vue mycélienne") et #wikilink("4 - Rouleau de journal").

#callout("important")[
En mode Sans distraction, appuyez sur *Esc* pour revenir à la disposition normale.
]

=== Références et collaboration

#table(
  columns: (auto, auto),
  table.header([Raccourci], [Action]),
  [`Ctrl+Shift+C`], [Rechercher des références et citer],
  [`Ctrl+Shift+\`], [Insérer un scaffold],
  [`Ctrl+Shift+S`], [Synchroniser (git)],
  [`Ctrl+Shift+U`], [Vérifier les mises à jour (git)],
  [`Ctrl+Shift+E`], [Exporter le package (transfert hors ligne)],
  [`Ctrl+Shift+G`], [Importer le package (transfert hors ligne)],
)

Pour savoir ce qu'ils font, voyez #wikilink("1 - Collaboration",
) et #wikilink("7 - Citations et bibliographie")

#callout("tip")[
Toutes les commandes n'ont pas de raccourci. Tout ce qui n'en a pas est facilement accessible dans la Palette de commandes (*Ctrl+P*). Commencez à taper le nom pour voir une liste de possibilités.
]

== Puis-je changer les raccourcis ?

Vous pouvez personnaliser les raccourcis des *règles de création de notes* (comme Nouvelle note, Note quotidienne, ou d'autres règles que vous créez) depuis l'éditeur de Règles de création (voyez #wikilink("2 - Paramètres")). Réassigner les autres raccourcis intégrés (par exemple, remapper *Ctrl+P*) n'est pas possible pour le moment.


== Pages connexes

- #wikilink("1 - L'interface InkyCap")
- #wikilink("2 - Modifier des notes")
- #wikilink("3 - Mettre en forme votre texte")
- #wikilink("1 - Vues et navigation")
- #wikilink("2 - Paramètres")
\
