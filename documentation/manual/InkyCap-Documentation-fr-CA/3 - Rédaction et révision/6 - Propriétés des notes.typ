#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Propriétés des notes",
  description: "Comment utiliser les propriétés des notes, le panneau convivial de métadonnées typées qui alimente les collections, la recherche et l'interrogation Typst portable.",
  tags: ("documentation",),
)

= Propriétés des notes

== Ce que sont les propriétés

Chaque note dans InkyCap peut porter un petit bout d'information structurée sur elle-même : certaines sont incluses avec le système, comme un titre, une description, des étiquettes, les collections auxquelles elle appartient explicitement, etc. Vous pouvez aussi en ajouter de votre cru. Ce sont ses _propriétés_ : des morceaux typés de métadonnées qui se posent tranquillement tout en haut de la note.

Une façon facile de travailler avec elles est l'onglet *Propriétés* dans le panneau de droite. Vous remplissez des champs, cochez des cases et choisissez des dates sans jamais toucher au code. En coulisses, InkyCap garde tout synchronisé avec la source de la note.

Les propriétés rendent vos notes _trouvables_ et _organisables_. Une fois qu'une note connaît sa propre date, ses étiquettes et sa collection, InkyCap peut la rassembler dans la bonne #wikilink("2 - Collections"), la retrouver dans les recherches et laisser d'autres outils la lire aussi.

== Ouvrir le panneau Propriétés

+ Ouvrez n'importe quelle note dans un onglet.
+ Regardez le *panneau de droite* et choisissez l'onglet *Propriétés*.
+ Vous verrez une rangée par propriété déjà définie sur la note. Si aucune note n'est ouverte, le panneau affichera « Aucun fichier sélectionné ».

Les rangées apparaissent dans le même ordre où elles sont écrites dans la note.

Quand vous ouvrez une grande boîte de notes, InkyCap l'indexe en arrière-plan. Si InkyCap a déjà vu la note et qu'elle n'a pas changé depuis, ses propriétés apparaissent immédiatement depuis le cache. Une note nouvelle ou modifiée verra ses propriétés se remplir dès que l'indexation est terminée.

=== Anatomie d'une rangée de propriété

Chaque rangée comporte, de gauche à droite :

- Une *icône de type* qui fait aussi office de *poignée de glissement*. L'icône vous indique la forme de la valeur (texte, nombre, case à cocher, date, liste, et ainsi de suite). Faites-la glisser vers le haut ou le bas pour *réordonner* vos propriétés.
- Le *nom de la propriété*, affiché tel qu'écrit.
- L'*éditeur de valeur*, qui change selon le type de la propriété.
- Un *bouton kebab* (`⋮`), intitulé « Options de propriété », qui ouvre un petit menu pour cette rangée.

== Propriétés intégrées courantes

InkyCap comprend une poignée de propriétés d'emblée. Leurs types sont fixes, largement au service de différentes fonctionnalités du système :

- *title* est un nom pour la note (texte), qui peut différer du nom de fichier.
- *description* sert de résumé (texte). C'est aussi ce qui apparaît dans les tables des matières et les aperçus.
- *tags* est une liste de mots-clés. Voir #wikilink("5 - Étiquettes") pour savoir comment les étiquettes alimentent le parcours et le filtrage.
- *aliases* liste d'autres noms sous lesquels cette note peut être trouvée, saisis comme une liste séparée par des virgules (par exemple `titre de travail, nom provisoire`).
- *date* et *due* sont des dates de calendrier, choisies avec un sélecteur de date et utiles pour des choses comme la vue Agenda.
- *task* est une case à cocher pour transformer une note en quelque chose d'actionnable (et l'inclure dans la vue Agenda).
- *source* fournit un champ pour inclure un URI associé.
- *collection* indique les #wikilink("2 - Collections") auxquelles vous voulez assigner explicitement cette note.

#callout("tip")[ Rien ne vous oblige à remplir chaque champ, ni même aucun champ. Ajoutez de l'information quand une propriété vous est utile. ]

== Modifier des valeurs

L'éditeur de chaque rangée correspond à son type :

- Les champs *Texte* sont de simples boîtes cliquer-pour-modifier. Si vous tapez un lien wiki comme `[[Une note]]`, il devient un lien cliquable à même la valeur.
- Les champs *Nombre* n'acceptent que des chiffres et vous avertissent doucement avec « Nombre invalide » si vous dérapez.
- Les champs *Case à cocher* sont une seule case ; le nom de la propriété en porte le sens.
- Les champs *Date* et *Date et heure* ouvrent un sélecteur de calendrier.
- Les champs *Liste* affichent vos valeurs comme des pastilles à sélection multiple. Cliquez sur la rangée, ou appuyez sur *Entrée* pendant qu'elle a le focus, pour ouvrir une liste des valeurs déjà utilisées pour cette propriété ailleurs dans votre boîte de notes. Tapez dans la boîte *Filtrer ou ajouter…* pour restreindre la liste ; les touches fléchées (ainsi que *Début* et *Fin*) déplacent le surlignage, et *Entrée* ajoute ou retire la valeur surlignée, de sorte que quelques lettres et *Entrée* suffisent habituellement. Si ce que vous avez tapé n'est pas encore dans la liste, une rangée `+ Ajouter « ... »` apparaît ; choisissez-la pour créer la valeur. *Échap* ferme la liste et vous ramène aux pastilles, et *Retour arrière* dans une boîte de filtre vide retire la dernière pastille.
- Le champ *collection* a son propre sélecteur : cliquez dessus pour inclure explicitement la note dans des collections particulières que vous avez créées. Si vous n'en avez encore créé aucune, il affichera « Aucune collection définie ».

Une propriété vide affiche simplement « Vide » jusqu'à ce que vous cliquiez dedans et commenciez à taper.

== Ajouter une propriété

+ Au bas du panneau Propriétés, cliquez sur *+ Ajouter une propriété*.
+ Commencez à taper dans la boîte (« Créer une nouvelle propriété ou en sélectionner une existante... »).
+ Un menu déroulant suggère des noms de propriété connus et déjà utilisés. Ceux intégrés à InkyCap portent un petit badge *système*. Cliquez sur une suggestion pour l'ajouter aussitôt.
+ Si vous créez un champ *tout neuf*, un court menu de type apparaît pour que vous choisissiez quel genre de valeur il contient : Case à cocher, Date, Date et heure, Liste, Liste séparée par virgules, Nombre ou Texte.

Les champs personnalisés sont une excellente façon de suivre ce qui compte pour votre travail : un `statut`, une note de lecture, un code de cours, un objectif de mots pour un manuscrit, n'importe quoi. InkyCap se souviendra du type que vous avez choisi et offrira ce champ comme suggestion sur d'autres notes aussi.


#callout("caution")[Une propriété de type liste diffère d'une liste séparée par virgules parce qu'elle vous fournit une interface pour choisir parmi toutes les options que vous avez créées. Une liste séparée par virgules est un champ de texte dans lequel chaque élément est séparé par une virgule. Une liste séparée par virgules est probablement la plus utile dans le cas où vous ne voulez pas utiliser une grande interface de liste mais voulez tout de même intégrer plusieurs valeurs préexistantes.]


== Changer ou retirer une propriété

Ouvrez le menu kebab d'une rangée (`⋮`) pour deux choix :

- *Type de propriété*, pour vos propres champs personnalisés, vous laisse changer le type du champ. Changer un type met à jour ce champ dans _chaque_ note qui l'utilise, en convertissant les valeurs existantes pour qu'elles conviennent. (Les champs intégrés ont des types fixes, donc cette option est masquée pour eux.)
- *Retirer* retire la propriété de *cette note seulement*, laissant les autres notes intactes.

#callout("note")[ Retirer la toute dernière propriété d'une note fait un ménage complet. InkyCap supprime le bloc de métadonnées entier plutôt que d'en laisser un vide derrière. ]

== Comment les propriétés sont stockées

Vous n'avez pas besoin de modifier la source à la main, car la barre latérale de droite de l'éditeur visuel fournit une interface, mais il est utile de savoir ce qui se passe. Toutes les propriétés d'une note vivent comme arguments nommés d'un unique appel `#note(...)` en haut du fichier, juste après la ligne d'importation de la boîte de notes. Les propriétés d'une note pourraient ressembler à ceci en mode source :

```typ
#note(
  title: "My note",
  tags: ("draft", "research"),
  date: datetime(year: 2026, month: 6, day: 5),
  collection: ("Thesis",),
)
```

Quand vous modifiez un champ dans le panneau, InkyCap réécrit _seulement_ cet argument-là et laisse tout le reste exactement comme il était. Vos autres valeurs, votre espacement et même vos commentaires sont préservés. Réordonner les rangées par glissement fait de même : il ne fait que réordonner les arguments sans toucher à leurs valeurs.

#callout("tip", title: "Pour les utilisateurs de Typst")[
  `#note(...)` provient du package `inkycap-notebox` fourni et émet un dictionnaire `#metadata(...)` étiqueté de l'étiquette stable `<inkycap-note>` (au plus un par fichier). Cela signifie que n'importe quelle chaîne d'outils Typst peut faire `query()` sur l'étiquette et lire le même dictionnaire. Vos métadonnées sont du Typst pur, portable (texte), pas un canal latéral propriétaire.

  Quelques conversions se produisent à l'intérieur de `note()` : les champs de type liste (`tags`, `collection`, `aliases`) acceptent une chaîne nue et l'enveloppent dans un tableau à un élément ; `aliases` découpe en plus sur les virgules ; et les valeurs `datetime` sont converties en chaîne `YYYY-MM-DD`. Une valeur `[[Target]]` est sérialisée en un appel `link-ref("Target")` afin qu'elle rejoigne le graphe de liens (voir #wikilink("4 - Liens et rétroliens")).
]

== Typé et portable, ça compte

Parce que les propriétés sont des métadonnées Typst interrogeables sous une étiquette stable, InkyCap peut les indexer et s'en servir pour offrir des fonctionnalités que vous rencontrerez ailleurs :

- *Les collections* rassemblent les notes automatiquement en interrogeant des propriétés comme `collection` ou `tags`, alors bien régler vos propriétés est ce qui fait que les #wikilink("2 - Collections") se remplissent d'elles-mêmes.
- *Les listes et sélecteurs* proposent les valeurs que vous avez déjà utilisées dans la boîte de notes, gardant votre vocabulaire cohérent.
- *D'autres outils Typst* peuvent lire les mêmes métadonnées, de sorte que vos notes restent utiles hors d'InkyCap.

#callout("important")[ Dans l'éditeur visuel, le bloc de propriétés en haut d'une note est masqué et verrouillé pour que vous ne puissiez pas le déranger par accident. Pour changer les propriétés, utilisez l'onglet Propriétés dans le panneau de droite (ou basculez en mode source où vous pouvez les modifier en ligne). Cela garde vos métadonnées en sécurité pendant que vous écrivez. ]

== Pages connexes

- #wikilink("2 - Collections"). Rassembler des notes automatiquement à l'aide de leurs propriétés.
- #wikilink("5 - Étiquettes"). Parcourir et filtrer par la propriété `tags`.
- #wikilink("4 - Liens et rétroliens"). Comment les valeurs `[[Target]]` relient vos notes entre elles.
- #wikilink("2 - Importer des notes existantes"). Faire correspondre le frontmatter des fichiers importés aux propriétés.
