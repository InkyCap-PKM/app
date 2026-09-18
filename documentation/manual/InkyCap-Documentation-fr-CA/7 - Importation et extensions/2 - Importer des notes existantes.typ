#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Importer des notes existantes",
  description: "Comment apporter des notes Markdown et Obsidian dans InkyCap : importer un dossier ou un coffre, faire correspondre le frontmatter YAML à des propriétés, et coller du Markdown.",
  tags: ("documentation",),
)

= Importer des notes existantes

== Apporter vos notes existantes

Si vous conservez déjà des notes dans des fichiers markdown (y compris dans un outil comme Obsidian), vous n'avez pas à repartir de zéro. InkyCap peut lire ces fichiers, convertir leur format markdown en notes formatées en Typst, et faire le ménage dans leurs liens, leurs images et leurs métadonnées en cours de route. Cette page vous guide à travers l'importation d'un dossier complet de notes, l'ajout d'un seul fichier Markdown, ainsi que la petite tâche du quotidien qui consiste à coller un extrait de Markdown dans une note que vous êtes déjà en train de rédiger.

#callout("note")[
L'importation se fait *dans la boîte de notes que vous avez présentement ouverte*. Si vous voulez repartir à neuf, créez ou ouvrez d'abord une boîte de notes vide (voir #wikilink("3 - Configurer votre boîte de notes")), puis importez dedans.
]

== Importer un dossier Markdown ou un coffre Obsidian

InkyCap lit vos notes à partir d'une *archive* (un fichier `.zip` ou `.tar.gz`), alors la première étape consiste à regrouper vos notes.

+ Placez les notes que vous voulez importer (ainsi que les images qu'elles utilisent) dans un seul dossier, puis compressez ce dossier en une archive `.zip` ou `.tar.gz`. Si vous importez un coffre Obsidian, compressez simplement le dossier complet du coffre. InkyCap sait comment le lire (vous voudrez peut-être supprimer plus tard certains fichiers qui ne sont pas utiles à InkyCap).
+ Dans InkyCap, ouvrez *Paramètres* et allez à l'onglet *Importation/Exportation et sauvegarde*.
+ Sous *Importer des fichiers Markdown*, cliquez sur *Choisir une archive…* et sélectionnez votre archive dans le sélecteur de fichiers.
+ Confirmez (ou modifiez) le *Dialecte source*, puis cliquez sur *Lancer l'importation*.

Voilà tout le processus. InkyCap analyse vos fichiers, peut vous poser quelques questions sur vos métadonnées (voir _Faire correspondre vos propriétés_ ci-dessous), convertit tout en Typst et copie vos images au bon endroit. Une fois terminé, vous verrez un résumé du genre _« 123 note(s) et 16 fichier(s) importés. »_

=== Standard ou Obsidian : quel dialecte ?

Quand vous sélectionnez votre archive, InkyCap y jette un coup d'œil. S'il y trouve le révélateur dossier `.obsidian`, il sélectionne automatiquement le dialecte *Obsidian* pour vous ; sinon, il choisit *Standard*. Vous pouvez modifier ce choix avant de lancer l'importation.

La différence porte surtout sur la façon dont les caractères `#` et `$` sont traités :

- *Obsidian* traite les éléments supplémentaires (mots-clics `#tag`, math `$math$` et commentaires `%%comments%%`) et suppose que tout `#` littéral dans votre texte a été écrit `\#`.
- *Standard* traite chaque `#` comme un caractère ordinaire. Choisissez cette option pour du Markdown ordinaire (non Obsidian), afin que des choses comme un prix (`$3000`) ou une référence à un ticket (`#42`) arrivent intactes plutôt que d'être prises pour de la syntaxe spéciale.

== Faire correspondre vos propriétés

Beaucoup de notes portent des métadonnées en tête (un titre, des étiquettes, une date, une liste d'alias). Pour les notes Markdown, cela se trouve habituellement dans un bloc de *frontmatter YAML*. InkyCap transforme ces métadonnées en #wikilink("6 - Propriétés des notes"), les champs typés qu'InkyCap comprend dans son format Typst.

Comme vos noms de champs pourraient ne pas correspondre à ceux d'InkyCap, une fenêtre *Associer les propriétés importées* apparaît chaque fois qu'un frontmatter est trouvé. (Si vos notes n'ont pas de frontmatter, cette étape est sautée et l'importation se poursuit simplement.) Pour chaque champ, vous verrez :

- *Propriété YAML* est le nom de champ d'origine, un exemple de valeur, et combien de fichiers l'utilisent.
- *Associée à* est l'endroit où il devrait aller. Vous pouvez l'associer à une *propriété système* intégrée, à l'une de *vos* propriétés personnalisées existantes, *créer une nouvelle propriété* pour lui, ou choisir *Ne pas importer* pour le laisser de côté.
- *Type*, pour une toute nouvelle propriété, est le genre de valeur qu'elle contient : Texte, Nombre, Liste, Liste séparée par virgules, Date, Date et heure, ou Case à cocher. Quand vous l'associez à une propriété existante, le type est déjà fixé pour vous.

InkyCap fait des suppositions de départ sensées. Les noms courants s'associent automatiquement. Par exemple, `title` devient le titre, `tags` (ou `tag`) devient les étiquettes, `aliases` devient les alias, `date`/`created` devient la date, et `description`/`summary` devient la description. Tout ce qu'il ne reconnaît pas est proposé comme une nouvelle propriété nommée d'après votre champ, avec son type deviné à partir d'un exemple de valeur.

#callout("note")[
Vous pouvez associer votre propre champ à une propriété système, mais vous ne pouvez pas *créer une nouvelle* propriété qui utilise un nom système réservé. InkyCap vous demandera plutôt de l'associer à celle-ci. Les valeurs vides et le YAML profondément imbriqué sont abandonnés.
]

#callout("tip", title: "Pour les utilisateurs de Typst")[
Le frontmatter atterrit sous forme d'un appel `#note(...)` en tête de chaque note importée. Il utilise le même mécanisme de métadonnées typées que vous écririez à la main. Les valeurs sont analysées avec un typage YAML adéquat (listes, nombres, booléens, dates ISO), et une valeur de frontmatter `"[[Name]]"` est émise comme une référence :
```typ
link-ref("Name")
```
]

== Ce qui se convertit, et à quoi s'attendre

Le convertisseur d'InkyCap gère les blocs de base courants du Markdown et les transforme en leurs équivalents Typst.

- *Titres, gras, italique, listes* (à puces et numérotées, y compris l'imbrication) sont tous repris.
- *Listes de tâches* (`- [ ]` et `- [x]`) deviennent des tâches InkyCap, donc elles apparaissent dans votre #wikilink("3 - Agenda, tâches et dates").
- *Tableaux, citations en bloc et blocs de code* se convertissent directement, en préservant les langages des blocs de code.
- *Callouts Obsidian* comme `> [!note] Title` deviennent des callouts InkyCap.
- *Surlignages* (`==comme ceci==`) et *CriticMarkup* éditorial (insertions, suppressions, commentaires) sont reconnus.

Les liens reçoivent un soin particulier :

- Un `[[Wikilink]]` (ou `[[Name|Display text]]`) devient un lien wiki InkyCap ; voir #wikilink("4 - Liens et rétroliens") pour comprendre comment ceux-ci alimentent la navigation et les rétroliens automatiques.
- Un lien interne vers un autre fichier `.md` est transformé en lien wiki vers cette note (le fichier `.typ` nouvellement converti).
- Un lien web externe ou une adresse courriel reste un lien normal.

#callout("warning")[
Les notes de bas de page sont reconnues, mais leur texte n'est pas entièrement rattaché, alors vérifiez vos notes de bas de page après l'importation. Le math LaTeX nécessite un traitement particulier ; voir ci-dessous.
]

=== Le math venant de Markdown

Le math en Markdown est écrit en LaTeX, que Typst ne compose pas de lui-même. Les expressions simples qui se trouvent à être du Typst valide (comme `E = mc^2`) passent et continuent de fonctionner comme du math natif. Le LaTeX plus élaboré est géré de l'une des deux façons suivantes :

- Si le package Typst *#link("https://typst.app/universe/package/mitex")[mitex]* est installé dans votre boîte de notes, le LaTeX est enveloppé pour s'afficher correctement.
- Sinon (le cas par défaut), l'équation est conservée telle quelle dans un bloc de code, afin que *rien ne soit perdu* et que la note continue de compiler. Le résumé d'importation vous rappellera que vous pouvez installer le package `@preview/mitex` et réimporter pour l'afficher. Voir #wikilink("3 - Scaffolds, Templates et Packages") pour l'installation de packages.

#callout("note")[
Le math n'est interprété que dans le dialecte *Obsidian*, puisque le Markdown ordinaire n'a pas de syntaxe mathématique.
]

== Vos images et pièces jointes

Vous n'avez pas à déplacer les images à la main. Les images Markdown standards (`![alt](path/picture.png)`) comme les intégrations de style Obsidian (`![[picture.png]]`) sont copiées dans le dossier de pièces jointes désigné de votre boîte de notes, et la note est pointée vers le nouvel emplacement. Vous définissez ce dossier sous *Paramètres → Fichiers et liens → Dossier des pièces jointes* (il s'appelle *Assets* par défaut).

Quelques détails :

- Les images sont appariées par nom de fichier, donc le sous-dossier dans lequel elles vivaient n'a pas d'importance.
- Les images hébergées sur le web (`http://`, `https://`) sont laissées exactement telles quelles.
- Le *texte alternatif* des images est repris.
- Les dossiers cachés tels que `.obsidian` et `.trash` sont ignorés.
- Si une image est référencée mais absente de votre archive, InkyCap le signale comme une erreur afin que vous puissiez la corriger à la main.

#callout("tip")[
Incluez vos images dans la même archive que vos notes. Si vous exportez vos notes sans leurs pièces jointes, les références se convertiront quand même, mais les images ne seront pas là pour être copiées.
]

== Ajouter un seul fichier Markdown

Vous n'avez pas besoin d'une archive pour un ou deux fichiers. Glissez un fichier `.md` depuis votre bureau ou votre gestionnaire de fichiers dans la fenêtre d'InkyCap, ou cliquez sur le bouton *Plus d'options* en haut de l'arborescence de fichiers, choisissez *Copier dans la boîte de notes*, puis sélectionnez le fichier. Dans les deux cas, InkyCap remarque qu'un fichier Markdown est une note plutôt qu'une pièce jointe et vous demande *Convertir le Markdown en Typst?* avec deux choix :

- *Convertir en Typst* convertit le fichier en une nouvelle note au premier niveau de votre boîte de notes, avec son frontmatter transformé en propriétés et toute image qui l'accompagne copiée dans votre dossier de pièces jointes.
- *Conserver en Markdown* copie le fichier tel quel.

La question est posée une seule fois par opération, même quand plusieurs fichiers Markdown sont concernés. Appuyer sur *Échap* annule toute l'importation.

Ce chemin rapide utilise le dialecte *Standard* et applique les suppositions de propriétés par défaut d'InkyCap sans rien demander ; la fenêtre *Associer les propriétés importées* n'apparaît pas. Si vous voulez choisir comment vos champs sont associés, utilisez l'importation par archive décrite ci-dessus.

== Coller du Markdown dans une note

Pour les petits travaux (un paragraphe tiré d'une page web, un extrait reçu d'un collègue), vous n'avez pas besoin d'une importation complète. Avec une note ouverte, lancez la commande *Coller depuis Markdown* (trouvez-la dans la palette de commandes sous _Édition_ ou filtrez la palette en tapant `markdown`). InkyCap lit le Markdown de votre presse-papiers, le convertit en Typst et le dépose à l'emplacement de votre curseur.

Ce collage rapide utilise le dialecte *Standard* (les choses comme les prix ou les références survivent) et applique les suppositions de propriétés par défaut d'InkyCap sans rien demander ; il est conçu pour être rapide et discret.

#callout("note")[
Sous Linux, cette commande lit directement le presse-papiers du système et s'est avérée un peu capricieuse à déclencher dans certaines configurations. Si un collage ne semble pas fonctionner, une importation complète par archive sera plus fiable.
]

== Allers-retours (importation et exportation)

InkyCap vise à garder l'importation et l'exportation à égalité ; les tableaux, surlignages, callouts et autres voyagent dans les deux directions (vous pouvez exporter les notes Typst d'InkyCap vers des notes Markdown). Néanmoins, la conversion entre formats n'est pas nécessairement parfaite. Après une importation d'envergure, il vaut la peine de vérifier quelques notes pour confirmer que tout est comme vous l'attendiez, particulièrement les notes de bas de page et tout math complexe.

== Pages connexes

- #wikilink("3 - Configurer votre boîte de notes"). Créez ou ouvrez la boîte de notes dans laquelle vous importerez.
- #wikilink("6 - Propriétés des notes"). Comment la correspondance des métadonnées se retrouve dans vos notes.
- #wikilink("4 - Liens et rétroliens"). Ce que débloquent vos liens wiki convertis.
- #wikilink("3 - Scaffolds, Templates et Packages"). Installer le package mitex pour le math LaTeX.
- #wikilink("3 - Exportation et publication"). Renvoyer des notes vers Markdown et d'autres formats.
