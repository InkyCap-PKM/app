#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Étiquettes",
  description: "Comment fonctionnent les étiquettes dans InkyCap : ajouter des étiquettes en ligne et comme propriété, les parcourir dans la barre latérale plate des étiquettes et s'en servir pour bâtir des Collections.",
  tags: ("documentation",),
)

= Étiquettes

== À quoi servent les étiquettes

Une _étiquette_ est une courte mention que vous attachez à une note pour la regrouper avec d'autres sur le même sujet. Étiquetez une poignée de notes, par exemple `à-lire`, `réunion` ou `soumettre`, et vous pouvez toutes les ramener ensemble en un seul clic, sans fouiller dans les dossiers.

Les étiquettes dans InkyCap sont plus que de simples mentions visuelles : ce sont des _métadonnées interrogeables_. Cela veut dire qu'InkyCap garde un index vivant de chaque étiquette et des notes qui la portent, de sorte que le navigateur d'étiquettes, la recherche et les #wikilink("2 - Collections") restent tous à jour automatiquement à mesure que vous écrivez.

#callout("note")[
  Les étiquettes forment une liste plate par conception ; il n'y a ni imbrication ni hiérarchie d'étiquettes. Une étiquette écrite comme `projet/alpha` sera traitée comme une seule mention simple, jamais découpée en arbre. Le recours aux liens wiki, aux propriétés personnalisées, aux dossiers et aux #wikilink("2 - Collections") peut offrir une organisation supplémentaire fondée sur des règles.
]

== Deux façons d'ajouter une étiquette

Une note peut être étiquetée de deux façons, et les deux alimentent le même index. Si le même nom apparaît des deux façons sur une note, il est compté une seule fois.

=== Les étiquettes comme propriété de note

Les étiquettes sont avant tout destinées à être utilisées tout en haut d'une note comme propriété de document, aux côtés du titre, de l'auteur et des autres propriétés de la note, voir #wikilink("6 - Propriétés des notes") :

```typ
#note(tags: ("research", "typst"))
```

Celles-ci vivent dans les métadonnées de la note, au-delà de la prose. Vous pouvez les modifier en source ou par le panneau de propriétés. Les étiquettes améliorent la récupération de vos notes grâce à un paramètre de recherche spécial et sont utiles pour regrouper des notes dans un filtre de collection.

#callout("warning")[
  La propriété `tags:` ne *découpe pas* sur les virgules. Écrire `tags: "a, b"` vous donne une seule étiquette littéralement nommée `a, b`. Pour enregistrer deux étiquettes distinctes, utilisez un tableau avec chaque nom dans ses propres guillemets : `tags: ("a", "b")`. (C'est délibéré, pour qu'une étiquette qui contient véritablement une virgule ne soit pas discrètement scindée.)
]

=== Étiquettes en ligne

Bien que conçues comme une propriété de métadonnées au niveau de la note, il est aussi possible de placer une étiquette n'importe où dans le corps d'une note. Vous pouvez taper la fonction d'étiquette avec le nom entre guillemets :
```typ
#tag("methodology")
```

Dans l'éditeur visuel, cela apparaît comme une petite pastille violette affichant `#methodology` sur laquelle vous pouvez cliquer. Dans votre document fini et rendu, elle apparaît comme une boîte en ligne (vous pouvez désactiver cela, comme montré plus bas).

#callout("tip")[
  Vous tapez les étiquettes à la main avec `#tag("nom")`. Il n'y a pas de liste d'autocomplétion qui surgit à mesure que vous tapez un nom d'étiquette, alors une façon rapide de rester cohérent est de jeter un œil à la barre latérale *Étiquettes* (ci-dessous) pour voir les noms que vous avez déjà utilisés.
]
#callout("tip", title: "Pour les utilisateurs de Typst")[
  Les deux formes émettent `[#metadata((name: name)) <inkycap-tag>]`, de sorte que tout se résout par `typst query` contre l'étiquette stable `<inkycap-tag>`. La propriété `tags:` est un champ de liste : une chaîne nue est convertie en tableau à un élément, et un `tags: ()` explicitement vide est préservé dans la source. Les noms de propriété et en ligne sont fusionnés et dédupliqués par note dans l'index.
]


== Parcourir et retrouver des notes par étiquette

Ouvrez la barre latérale *Étiquettes* en cliquant sur le bouton *Étiquettes* dans le rail de modes de la barre latérale de gauche. Le volet liste chaque étiquette de votre boîte de notes en liste plate, chaque rangée affichant le nom de l'étiquette et un compte du nombre de notes qui la portent.

Vous pouvez façonner la liste à votre goût :

- *Triez* avec le bouton de tri. La valeur par défaut est *Alphabétique (A – Z)*, mais vous pouvez choisir *Alphabétique (Z – A)*, *Quantité (élevée – faible)* ou *Quantité (faible – élevée)*.
- *Filtrez* avec le bouton de filtre, qui révèle une boîte *Filtrer les étiquettes…*. Tapez quelques lettres pour restreindre la liste aux noms correspondants.

*Cliquez sur n'importe quelle étiquette* pour ouvrir le panneau de recherche pré-rempli avec cette étiquette, listant chaque note qui la porte. (Si vous n'avez encore aucune étiquette, le volet affiche simplement « No tags found. »)

Vous pouvez aussi chercher par étiquette directement depuis le panneau de recherche de #wikilink("1 - Vues et navigation") avec le préfixe `tag:`, par exemple `tag:research`. C'est combinable avec le reste du langage de recherche d'InkyCap. Par exemple, pour trouver toutes vos notes de recherche sur les hiboux, vous pourriez chercher le mot `hibou` et inclure `tag:research`, ce qui limitera la portée de vos résultats aux seuls fichiers étiquetés `research` et contenant le mot `hibou` quelque part dans leur contenu.

#callout("note")[
  La correspondance d'étiquette dans la recherche est _insensible à la casse_ et correspond à une _partie_ du nom, pas à l'ensemble. Ainsi, `tag:rust` fera ressortir des notes étiquetées `Rustacean` ou `rust-lang` aussi bien que `rust`. Pratique pour ratisser large ; bon à savoir si vous vous attendez à une correspondance exacte.
]

== Renommer et supprimer des étiquettes

_Faites un clic droit_ sur n'importe quelle étiquette dans la barre latérale *Étiquettes* de gauche pour deux actions à l'échelle de la boîte de notes :

+ *Renommer* vous laisse taper un nouveau nom sur place et appuyer sur Entrée. Si une étiquette de ce nom existe déjà, InkyCap demande s'il faut *fusionner* les deux ; confirmer les regroupe partout.
+ *Supprimer* retire l'étiquette de chaque note qui l'utilise (on vous demandera de confirmer, puisque c'est irréversible).
\

== Utiliser les étiquettes pour bâtir des collections

Les étiquettes sont utiles dans les #wikilink("2 - Collections"), un groupe de notes vivant et fondé sur des règles. Un filtre de collection peut inclure ou exclure des notes par étiquette :

- `file.tags.contains("rust")` correspond aux notes qui portent l'étiquette (affiché comme *contains* dans le générateur de filtres).
- `!file.tags.contains("rust")` correspond à celles qui ne la portent pas (*not contains*).
- `tags.isEmpty()` correspond aux notes sans aucune étiquette.

Dans le générateur de filtres, `file.tags` se trouve sous le groupe de propriétés *File*. Comme les règles sont évaluées en direct, toute note que vous étiquetez plus tard rejoint automatiquement la collection, sans entretien manuel.

== Afficher ou masquer les étiquettes dans votre sortie

Par défaut, les étiquettes en ligne apparaissent comme de petites boîtes en mode lecture et dans les exportations. Si vous préférez les garder comme métadonnées d'organisation invisibles, allez dans *Settings → Appearance → Rendering Defaults* et désactivez *Show inline tags*. Les étiquettes restent indexées et entièrement consultables ; elles ne s'impriment simplement pas.

#callout("note")[
  Ce réglage n'affecte que la sortie rendue et exportée. Dans l'éditeur visuel, la pastille d'étiquette violette reste toujours visible pour que vous puissiez voir et cliquer vos étiquettes pendant l'écriture.
]

== Les étiquettes ailleurs dans InkyCap

Les étiquettes aident discrètement à quelques autres endroits :

- Dans le #wikilink("4 - Rouleau de journal"), le panneau Contexte du rouleau fait surgir une section *Étiquettes* montrant quelles étiquettes se concentrent à travers les entrées que vous regardez.
- À l'exportation, les `tags:` d'une note deviennent des mots-clés PDF ou des balises `<meta>` HTML, aidant votre travail publié à être trouvé.
- Les tâches peuvent porter leurs propres étiquettes aussi (voir #wikilink("3 - Agenda, tâches et dates")).

== Pages connexes

- #wikilink("6 - Propriétés des notes"). Définir les étiquettes et d'autres métadonnées en haut d'une note.
- #wikilink("4 - Liens et rétroliens"). L'autre moitié de la trousse « reliez-vos-notes » d'InkyCap.
- #wikilink("2 - Collections"). Transformer les étiquettes en groupes vivants fondés sur des règles.
