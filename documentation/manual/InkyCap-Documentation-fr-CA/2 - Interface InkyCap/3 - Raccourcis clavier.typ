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

Appuyez sur *`F1`* (ou cliquez sur le bouton *Aide* de la barre d'outils verticale ; son infobulle se lit *Aide (F1)*) pour ouvrir le panneau d'Aide. Il offre trois vues entre lesquelles vous pouvez basculer :

- *Raccourcis d'interface*. Chaque raccourci global regroupé par catégorie.
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
  [`Ctrl+Shift+F`], [Rechercher dans toute la boîte de notes],
  [`F6`], [Cibler la région suivante (barre latérale, éditeur, panneau…)],
  [`Shift+F6`], [Cibler la région précédente],
  [`Ctrl+Shift+0`], [Sauter directement à l'éditeur actif],
  [`Esc`], [Depuis un panneau, ramener le focus à l'éditeur],
)

#callout("tip")[
*F6* parcourt les régions visibles de la fenêtre dans l'ordre, en sautant tout panneau que vous avez replié. C'est la façon, uniquement au clavier, d'atteindre la barre latérale ou un panneau latéral et de l'utiliser entièrement au clavier.
]

Quand un panneau est ciblé, vous pouvez parcourir ses propres onglets internes avec *Ctrl+PageDown* et *Ctrl+PageUp*. (Ceux-ci n'agissent qu'une fois que vous avez ciblé le panneau avec *F6* d'abord.)

À l'intérieur de l'arborescence des fichiers et d'autres listes, les touches fléchées déplacent la sélection, *Entrée* ou *Espace* ouvre ou active l'élément en surbrillance, et *Début* / *Fin* sautent aux extrémités. Dans l'arborescence des fichiers en particulier, *→* développe un dossier (ou y entre) et *←* le réduit (ou en ressort vers le parent).

Les menus fonctionnent de la même façon. Une fois qu'un menu est ouvert, y compris un menu contextuel, les touches fléchées parcourent ses éléments, *Début* / *Fin* sautent au premier et au dernier, *Entrée* ou *Espace* choisit, et *Esc* le ferme. *→* ou *Entrée* ouvre un sous-menu et *←* en ressort.

== Édition

Ceux-ci agissent sur la note que vous écrivez. Voyez #wikilink("2 - Modifier des notes") pour la vue d'ensemble du fonctionnement de l'édition.
#table(
  columns: (auto, auto),
  table.header([Raccourci], [Action]),
  [`Ctrl+N`], [Nouvelle note],
  [`Ctrl+D`], [Note du jour (note d'aujourd'hui)],
  [`Ctrl+T`], [Nouvel onglet vide],
  [`Ctrl+W`], [Fermer l'onglet],
  [`Ctrl+Shift+T`], [Rouvrir le dernier onglet fermé],
  [`Ctrl+M`], [Déplacer le fichier vers…],
  [`Ctrl+Shift+D`], [Supprimer le fichier],
  [`F2`], [Renommer le fichier courant],
  [`Ctrl+F`], [Rechercher dans la note courante],
  [`Ctrl+H`], [Rechercher et remplacer dans la note courante],
  [`Ctrl+=` / `Ctrl++`], [Zoomer],
  [`Ctrl+-`], [Dézoomer],
  [`Ctrl+0`], [Réinitialiser le zoom],
)

#callout("note")[
*Ctrl+N* et *Ctrl+D* proviennent des règles de création de notes intégrées d'InkyCap, alors ils se modifient à un endroit différent des autres : chaque règle de création a son propre raccourci modifiable dans *Règles de création* dans #wikilink("2 - Paramètres"). Voyez #wikilink("3 - Scaffolds, Templates et Packages") pour savoir comment fonctionnent les règles de création. Tous les autres raccourcis de cette page peuvent être changés depuis le panneau d'Aide, comme décrit à la fin de cette page.
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
  [`Ctrl+Shift+L`], [Basculer le thème sombre / clair],
  [`Ctrl+Shift+M`], [Basculer le mode Source / Aperçu en direct],
  [`Ctrl+Shift+R`], [Basculer le Mode lecture],
  [`Ctrl+Shift+1`], [Basculer le Mode sans distraction],
  [`Ctrl+Shift+]`], [Diviser l'éditeur vers la droite],
  [`Ctrl+Shift+[`], [Diviser l'éditeur vers le bas],
  [`Ctrl+Shift+W`], [Fermer le panneau d'éditeur courant],
  [`Ctrl+Shift+Y`], [Ouvrir la Vue mycélienne],
  [`Ctrl+Shift+J`], [Basculer le Rouleau de journal],
)

Les modes d'édition et les vues ci-dessus ont leurs propres pages : #wikilink("1 - Vues et navigation"), #wikilink("5 - Vue mycélienne") et #wikilink("4 - Rouleau de journal").

Une troisième sorte de division, *Diviser avec un aperçu synchronisé* (un mode lecture en direct de la même note à côté de l'éditeur), n'a pas de raccourci propre ; lancez-la depuis la Palette de commandes ou le menu *Options de l'onglet*. Voyez #wikilink("1 - L'interface InkyCap").

#callout("important")[
En Mode sans distraction, appuyez sur *Esc* pour revenir à la disposition normale.
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

== Changer les raccourcis

Oui, les raccourcis de la vue *Raccourcis d'interface* du panneau d'Aide peuvent être réassignés, et le changement prend effet immédiatement :

+ Appuyez sur *F1* pour ouvrir le panneau d'Aide et assurez-vous que *Raccourcis d'interface* est sélectionné. (Tapez dans le champ de filtre pour trouver rapidement la commande.)
+ Cliquez sur la combinaison de touches affichée à côté de la commande. Elle devient *Appuyez sur les touches…*.
+ Appuyez sur la nouvelle combinaison que vous voulez. C'est tout : les nouvelles touches sont enregistrées et apparaissent dans la liste, dans la Palette de commandes et dans les infobulles.

Pendant que le panneau attend vos touches :

- Appuyez sur *Retour arrière* (ou *Suppr*) pour retirer complètement le raccourci. La commande se lit alors *Non assigné* et reste dans la liste pour que vous puissiez lui donner une nouvelle combinaison plus tard.
- Appuyez sur *Esc* pour annuler et garder le raccourci tel qu'il était.
- Si la combinaison sur laquelle vous appuyez est déjà utilisée par une autre commande, InkyCap la refuse et affiche un message nommant la commande qui la possède. Les combinaisons réservées par l'éditeur (comme *Ctrl+B* pour le gras ou *Ctrl+I* pour l'italique) et par votre système d'exploitation sont refusées de la même façon.

Un raccourci que vous avez changé affiche une petite flèche de réinitialisation à côté de lui ; cliquez dessus pour rétablir la valeur par défaut de cette seule commande. Dès qu'un raccourci a été personnalisé, un bouton *Réinitialiser tous les raccourcis* apparaît en haut de la vue ; il demande une confirmation, puis rétablit chaque raccourci à sa valeur par défaut.

La seule exception est les raccourcis des *règles de création de notes* (comme Nouvelle note, Note du jour, ou les règles que vous créez vous-même). Ils apparaissent dans le panneau d'Aide à titre de référence, mais vous les changez dans l'éditeur des Règles de création (voyez #wikilink("2 - Paramètres")), pour que chaque règle conserve une seule source de vérité.


== Pages connexes

- #wikilink("1 - L'interface InkyCap")
- #wikilink("2 - Modifier des notes")
- #wikilink("3 - Mettre en forme votre texte")
- #wikilink("1 - Vues et navigation")
- #wikilink("2 - Paramètres")
\
