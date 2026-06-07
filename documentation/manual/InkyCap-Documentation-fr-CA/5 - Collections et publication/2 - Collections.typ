#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Collections",
  description: "Comment les collections transforment vos notes en une base de données interrogeable, semblable à un tableur : l'appartenance, les filtres, les vues table et agenda, ainsi que l'exportation CSV.",
  tags: ("documentation",),
)

= Collections

Une *collection* rassemble des notes apparentées dans une seule vue semblable à un tableur, que vous pouvez trier, filtrer et modifier sur place. Voyez-la comme une question enregistrée que vous posez à votre boîte de notes (« montre-moi chaque note de ma thèse » ou « chaque note du dossier Recherche qui contient encore une tâche ouverte »), à laquelle on répond par une table vivante qui se met à jour d'elle-même à mesure que vous écrivez.

Une collection n'est _pas_ un dossier. *Elle ne déplace, ne copie ni ne contient vos notes*. C'est une requête enregistrée accompagnée d'une vue, si bien qu'une même note peut apparaître dans plusieurs collections à la fois sans jamais quitter sa place dans l'arborescence de fichiers de votre boîte de notes.

#callout("note")[
  Les collections sont enregistrées automatiquement dans votre boîte de notes et gérées pour vous. Vous n'avez pas besoin de trouver ni d'organiser les fichiers de collection à la main. Créez-les depuis la section *Collections* de la barre latérale gauche avec le bouton *« + »*, donnez un nom à la collection, et une table de départ apparaît.
]

#callout("tip", title: "Contexte technique")[
  Une collection est un seul fichier YAML portant l'extension `.collection`, conservé dans le dossier réservé `.inkycap/collections/` à la racine de votre boîte de notes. Le fichier contient un groupe de filtres global, une ou plusieurs définitions de vue, des surcharges de style facultatives et des métadonnées d'exportation de livre ; mais vous modifiez tout cela à travers les panneaux de la collection, jamais sous forme de texte.
]

== Comment les notes rejoignent une collection

L'appartenance est décidée entièrement par des *filtres*. Il n'y a pas de liste « ajouter à la collection » distincte à entretenir. Une note apparaît lorsqu'elle correspond aux règles de la collection. Il existe deux façons complémentaires d'écrire ces règles, et vous pouvez les combiner librement.

=== La façon simple : la propriété « collection »

Le chemin le plus direct consiste à étiqueter une note avec le nom de la collection au moyen de la propriété *collection* de la note. La propriété `collection` est une liste intégrée, de sorte qu'une même note peut déclarer son appartenance à plusieurs collections à la fois.

Vous la définissez depuis l'éditeur de *Propriétés* du panneau de droite de la note (voir #wikilink("6 - Propriétés des notes")). Ajoutez le nom de la collection à la liste. Lorsque vous créez une collection nommée, InkyCap configure automatiquement une règle qui inclut toute note portant ce nom, alors « ça marche tout seul ».

#callout("tip", title: "Pour les utilisateurs de Typst")[
  La propriété figure dans l'appel `#note(...)` de la note sous forme de liste :
  ```typ
  #note(collection: ("My Paper", "Thesis"))
  ```
  Les importations Markdown y associent automatiquement une clé YAML `collections:`.
]

=== La façon puissante : des filtres sur n'importe quelle propriété

Vous n'avez pas du tout besoin de toucher à une note pour l'inclure. Une collection peut rassembler des notes selon _n'importe quel_ critère (le dossier où elles se trouvent, leurs #wikilink("5 - Étiquettes"), une date, une case à cocher, ou toute propriété que vous avez définie) à l'aide de filtres imbriqués *Tous / N'importe / Aucun*. Cela vous permet de bâtir une collection du genre « inclure tout ce qui est dans mon dossier Recherche _ou_ étiqueté `my-paper`, mais _pas_ le fichier de collection lui-même » sans modifier une seule note.

Les deux approches coexistent par conception : la règle par défaut qui correspond au nom de votre collection se trouve à l'intérieur d'un groupe *« N'importe »* précisément pour que vous puissiez ajouter des solutions de rechange (un dossier, une étiquette, un test de propriété) juste à côté.

== Construire des filtres

Ouvrez l'éditeur de filtres de la collection avec le bouton *Filtre* de la barre d'outils de la collection. Les filtres sont construits à partir de *groupes* imbriqués, et non d'une liste plate de règles, de sorte que vous pouvez exprimer des choses comme « (A ou B) et C ».

Chaque groupe possède un combinateur, affiché sous forme d'étiquette en langage clair :

- *Tous* : Chaque règle du groupe doit être vraie.
- *N'importe* : Au moins une règle doit être vraie.
- *Aucun* : Aucune des règles ne doit être vraie.

La légende du groupe vous est relue, par exemple « Tous les énoncés suivants sont vrais ». À l'intérieur d'un groupe, vous ajoutez :

+ *« + Ajouter un filtre »* ajoute une règle unique (une feuille).
+ *« + Ajouter un groupe de filtres »* ajoute un sous-groupe imbriqué, pour combiner des idées. Les groupes peuvent s'imbriquer jusqu'à trois niveaux de profondeur.

Une règle unique est une *propriété*, un *opérateur* et une *valeur*. Les opérateurs sont :

- *égale* / *n'égale pas*
- *contient* / *ne contient pas*
- *est vide* / *n'est pas vide* (aucune valeur requise)

Choisissez la propriété dans un menu déroulant regroupé en *Propriétés* (celles que vous avez rédigées) et *Fichier* (des détails intégrés comme le dossier, le nom du fichier ou la date de modification). Lorsque vous avez terminé, appuyez sur *Appliquer*.

#callout("important")[
  Un *filtre vide correspond à chaque note*. Une toute nouvelle collection sans règle listera l'ensemble de votre boîte de notes tant que vous ne l'aurez pas restreinte.
]

#callout("note")[
  Lorsqu'une règle compare une propriété de type _liste_ (comme `collection` ou `tags`) à une valeur unique, elle teste l'*appartenance* (« cette valeur est-elle dans la liste ? »). Ainsi, une règle « contient » sur `tags` trouve les notes qui portent cette étiquette, et la règle du nom de collection trouve les notes qui listent cette collection.
]

#callout("tip", title: "Pour les utilisateurs de Typst")[
  Les règles de filtre sont stockées sous forme de petites chaînes d'expression que vous pouvez aussi rédiger à la main. Les références de propriété peuvent être nues (`title`), entre crochets pour les clés malcommodes (`note["due-date"]`), des métadonnées de fichier (`file.folder`), ou une autoréférence au fichier de collection (`this.file.name`). `contains` est une correspondance de sous-chaîne sensible à la casse, une propriété absente compte comme vide, et une expression mal formée *échoue en se fermant* ; elle est simplement ignorée plutôt que de correspondre par accident. Le filtre par défaut garde une collection hors de ses propres résultats avec `file.name != this.file.name`.
]

== Les vues : tables et agendas

Une collection peut afficher plus d'une *vue*, chacune avec ses propres filtres, colonnes et tris. Les vues apparaissent sous forme d'onglets en haut de la collection. Le bouton *« + »* ajoute une vue et demande si vous voulez une *vue table* ou une *vue agenda*.

- Renommez une vue en double-cliquant sur son onglet.
- Réorganisez les vues en faisant glisser leurs onglets.
- Supprimez une vue avec son *×* (la première vue reste toujours, donc vous ne vous retrouvez jamais avec une collection vide).

Lorsque les onglets débordent, des boutons apparaissent pour vous permettre de faire défiler. InkyCap se souvient de la dernière vue que vous regardiez pour chaque collection.

== La vue table

La table est le cœur d'une collection : une ligne par note correspondante, une colonne par propriété que vous choisissez d'afficher. Elle se comporte comme un tableur familier.

*Ouvrir des notes.* La cellule du nom de fichier est un lien. Cliquez dessus pour ouvrir la note, ou faites Ctrl/Cmd-clic (ou clic du milieu) pour l'ouvrir dans un nouvel onglet. Faites un clic droit sur n'importe quelle ligne pour *Ouvrir la note*, *Ouvrir dans un nouvel onglet* ou *Exporter la note…*.

*Modifier sur place.* Cliquez sur la plupart des cellules pour les modifier directement : tapez une valeur et appuyez sur Entrée pour enregistrer (Échap annule). Les cases à cocher se basculent d'un seul clic. _Tout ce que vous tapez est réécrit directement dans les propriétés de la note_, de sorte que la table est une véritable surface d'édition, pas seulement un rapport.

#callout("note")[
  Les colonnes tirées des détails de fichier (le dossier, le chemin, les dates, la taille) sont en *lecture seule*, puisqu'elles proviennent du système de fichiers lui-même. Tout ce que vous avez rédigé comme propriété est modifiable.
]

*Choisir les colonnes.* Le bouton *Colonnes* ouvre une liste à cocher de chaque propriété disponible ; cochez celles que vous voulez voir apparaître comme colonnes. Faites glisser les en-têtes de colonne pour les réorganiser. La colonne du nom de fichier est toujours présente.

*Trier.* Cliquez sur un en-tête de colonne pour trier selon celle-ci, en passant par croissant (▲), décroissant (▼), puis de retour à aucun. L'en-tête selon lequel vous triez affiche la flèche pour que vous connaissiez toujours l'ordre actuel.

#callout("tip")[
  Des étiquettes conviviales gardent les en-têtes lisibles. Les détails de fichier s'affichent comme « Nom du dossier », « Date de modification », « Extension de fichier », et ainsi de suite, même si InkyCap stocke leurs clés techniques précises en coulisses.
]

== La vue agenda

Une vue *agenda* troque la grille pour une #highlight[liste ciblée de tâches et d'éléments datés tirés des notes membres de la collection (un tableau d'échéances limité exactement à cet ensemble de notes)]. Elle utilise les mêmes règles d'appartenance que la table, de sorte que les deux ne se contredisent jamais, et elle ne nécessite aucune activation particulière : l'appartenance par filtres suffit.

Cliquer sur un élément ouvre sa note (Ctrl/Cmd ou clic du milieu pour un nouvel onglet). Si une collection n'a aucune tâche ni élément daté, la vue le dit clairement. Pour le portrait complet du fonctionnement des tâches et des dates d'échéance dans votre boîte de notes, voir #wikilink("3 - Agenda, tâches et dates").

== Exporter vers un tableur

Lorsque vous voulez les données de votre collection hors d'InkyCap (dans un tableur comme LibreOffice Calc, Excel, Numbers, Google Sheets, ou un outil de statistiques), utilisez le bouton *Exporter* et choisissez :

- *Table en CSV* écrit des valeurs séparées par des virgules, le format de tableur universel.
- *Table en TSV* écrit des valeurs séparées par des tabulations, pratique lorsque votre texte contient des virgules.

L'exportation reflète exactement ce que vous voyez : les colonnes, les filtres et l'ordre de tri de la vue active. Les valeurs sont correctement entre guillemets et échappées, les listes sont jointes en une seule cellule, et les cellules vides restent vides. Vous obtiendrez une confirmation une fois le fichier enregistré.

#callout("note")[
  CSV et TSV sont les exportations _de tableur_ ; elles capturent les propriétés de votre collection sous forme de données. Le même menu *Exporter* rend aussi les notes elles-mêmes en PDF, en livre fusionné, en site HTML ou en fichiers Markdown. Ces flux de travail de publication, y compris les options de métadonnées et de structure du livre, sont couverts dans #wikilink("3 - Exportation et publication").
]

== Pages connexes

- #wikilink("6 - Propriétés des notes") : les métadonnées typées qui deviennent les colonnes et les filtres de votre collection.
- #wikilink("5 - Étiquettes") : une façon naturelle de piloter l'appartenance à une collection.
- #wikilink("3 - Agenda, tâches et dates") : comment les tâches et les échéances de la vue agenda sont rédigées.
- #wikilink("3 - Exportation et publication") : transformer une collection en PDF, en livre ou en site web.
